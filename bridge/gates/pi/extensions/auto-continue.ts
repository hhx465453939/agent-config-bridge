/**
 * auto-continue —— pi 长任务续跑扩展（**无轮次上限**）。
 *
 * 背景：pi 每一轮回复结束都会把控制权交回用户 —— 这是对话协议的边界，不是配置项。
 * 但扩展的 `turn_end` 边界可以追加一条输入并请求继续，这是唯一的合法入口。
 *
 * 实现要点（踩过的坑）：
 *   ❌ 不要在 turn_end 里调 `pi.sendUserMessage()`：此时 agent 仍在处理中，
 *      会抛 "Agent is already processing. Specify streamingBehavior ..."。
 *   ✅ 正确做法：返回 `{ continue: true, entries: [{ type: "custom_message", ... }] }`，
 *      由 boundary 机制在本轮结束后把这条输入并入下一轮。
 *
 * 停机条件（只有三个，**没有轮数上限**）：
 *   1. `/auto off`；
 *   2. 目标文件出现 `state: DONE`；
 *   3. 助手输出 `<promise>COMPLETE</promise>`。
 *
 * `remaining` 只是可选配额：-1 = 不限额（默认），正数 = 最多再续跑 N 轮，0 = 已停。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_REL = ".pi/auto-continue.json";
const TASKS_DIR = "tasks";

interface AutoState {
  enabled: boolean;
  /** -1 = 无限；正数 = 剩余轮数；0 = 已停 */
  remaining: number;
  prompt: string;
}

const DEFAULT_STATE: AutoState = {
  enabled: false,
  remaining: -1,
  prompt:
    "继续执行当前任务的下一个未完成步骤。" +
    "先查看仓库里的进度记录（如 tasks/、TODO、CHANGELOG 或上一轮的交付说明）确认做到哪一步，" +
    "然后直接实现、验证并提交。全部完成时输出 <promise>COMPLETE</promise>。" +
    "不要问我问题，不要停在中途汇报。",
};

function readState(): AutoState {
  const path = join(process.cwd(), STATE_REL);
  if (!existsSync(path)) return { ...DEFAULT_STATE };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AutoState>;
    return { ...DEFAULT_STATE, ...raw };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(state: AutoState): void {
  writeFileSync(join(process.cwd(), STATE_REL), JSON.stringify(state, null, 2) + "\n", "utf8");
}

function goalDone(): boolean {
  try {
    const dir = join(process.cwd(), TASKS_DIR);
    if (!existsSync(dir)) return false;
    for (const name of readdirSync(dir)) {
      const f = join(dir, name, "goal-state.yaml");
      if (!existsSync(f)) continue;
      if (/^state:\s*DONE\b/m.test(readFileSync(f, "utf8"))) return true;
    }
  } catch {
    /* 读不到就当作未完成 */
  }
  return false;
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: "text"; text: string } => (c as { type?: string })?.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

export default function (pi: ExtensionAPI) {
  pi.on("turn_end", async (event, ctx) => {
    if ((event.message as { role?: string } | undefined)?.role !== "assistant") return;

    const state = readState();
    if (!state.enabled) return;

    if (state.remaining === 0) {
      state.enabled = false;
      writeState(state);
      if (ctx.hasUI) ctx.ui.setStatus("auto-continue", "已停（配额用尽）");
      return;
    }
    if (goalDone()) {
      state.enabled = false;
      writeState(state);
      if (ctx.hasUI) ctx.ui.setStatus("auto-continue", "已完成");
      return;
    }
    if (textOf(event.message).includes("<promise>COMPLETE</promise>")) {
      state.enabled = false;
      writeState(state);
      if (ctx.hasUI) ctx.ui.setStatus("auto-continue", "已完成");
      return;
    }

    if (state.remaining > 0) {
      state.remaining -= 1;
      writeState(state);
    }
    if (ctx.hasUI) {
      const left = state.remaining < 0 ? "∞" : String(state.remaining);
      ctx.ui.setStatus("auto-continue", `续跑中 · 剩 ${left}`);
    }

    return {
      continue: true,
      entries: [
        {
          type: "custom_message" as const,
          customType: "auto-continue",
          content: state.prompt,
          display: false,
        },
      ],
    };
  });

  pi.registerCommand("auto", {
    description: "自动续跑：/auto on [轮数|-1] | /auto off | /auto status",
    handler: async (args, ctx) => {
      const state = readState();
      const [sub, n] = (args ?? "").trim().split(/\s+/);
      if (sub === "off") {
        state.enabled = false;
        state.remaining = 0;
        writeState(state);
        ctx.ui.notify("auto-continue 已关闭", "info");
        return;
      }
      if (sub === "on") {
        const turns = n === undefined ? -1 : Number(n);
        state.enabled = true;
        state.remaining = Number.isFinite(turns) ? turns : -1;
        writeState(state);
        ctx.ui.notify(
          state.remaining < 0
            ? "auto-continue 已开启（不限轮数）"
            : `auto-continue 已开启，剩 ${state.remaining} 轮`,
          "info",
        );
        return;
      }
      if (sub === "set") {
        const turns = Number(n);
        state.remaining = Number.isFinite(turns) ? turns : -1;
        state.enabled = state.remaining !== 0;
        writeState(state);
        ctx.ui.notify(`auto-continue remaining=${state.remaining}`, "info");
        return;
      }
      ctx.ui.notify(
        `auto-continue: ${state.enabled ? "on" : "off"} · remaining=${
          state.remaining < 0 ? "∞" : state.remaining
        }`,
        "info",
      );
    },
  });
}
