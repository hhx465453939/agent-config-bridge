/**
 * auto-continue —— 让 pi 在每轮结束时自动续跑，而不是把控制权交回用户。
 *
 * 背景：pi 的每一轮对话在机制上必然会结束（这不是配置项，也关不掉）。
 * 但扩展的 `turn_end` / `agent_before_settle` 边界可以返回 `continue: true`，
 * 或直接投递下一条用户消息 —— 这就是"续跑"的合法入口。
 *
 * 工作方式：
 *   1. 读 `.pi/auto-continue.json`（enabled / remaining / prompt）；
 *   2. 每轮结束检查：是否还有剩余次数、目标是否已完成（goal-state.yaml 里 state: DONE）；
 *   3. 未完成 → 扣减次数并投递下一条指令，pi 立刻开始下一轮；
 *   4. 次数用完或已完成 → 自动关闭，不再打扰。
 *
 * 安全阀：
 *   - remaining 上限 200（防止真正的死循环烧钱）；
 *   - 助手消息里出现 `<promise>COMPLETE</promise>` 立即停机；
 *   - `/auto off` 随时手动停。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_REL = ".pi/auto-continue.json";
const GOAL_GLOB = "tasks"; // 只扫 tasks/*/goal-state.yaml

interface AutoState {
  enabled: boolean;
  remaining: number;
  prompt: string;
}

const DEFAULT_STATE: AutoState = {
  enabled: false,
  remaining: 0,
  prompt:
    "继续执行 CHG-20261024-xuanji-founding 的下一个未完成里程碑。" +
    "先读 tasks/CHG-20261024-xuanji-founding/goal-state.yaml 与 TRACEABILITY.md 确认进度，" +
    "然后按 SPEC 实现、跑 bash scripts/check.sh 与 xuanji verify --all，" +
    "全绿后提交并推送。全部里程碑完成时输出 <promise>COMPLETE</promise>。" +
    "不要问我问题，不要停在中途汇报。",
};

function projectRoot(): string {
  return process.cwd();
}

function readState(): AutoState {
  const path = join(projectRoot(), STATE_REL);
  if (!existsSync(path)) return { ...DEFAULT_STATE };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AutoState>;
    return { ...DEFAULT_STATE, ...raw };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(state: AutoState): void {
  writeFileSync(join(projectRoot(), STATE_REL), JSON.stringify(state, null, 2) + "\n", "utf8");
}

function goalDone(): boolean {
  try {
    const dir = join(projectRoot(), GOAL_GLOB);
    if (!existsSync(dir)) return false;
    for (const name of readdirSync(dir)) {
      const f = join(dir, name, "goal-state.yaml");
      if (!existsSync(f)) continue;
      const text = readFileSync(f, "utf8");
      if (/^state:\s*DONE\b/m.test(text)) return true;
    }
  } catch {
    /* 读不到就当未完成 */
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
    const state = readState();
    if (!state.enabled) return;
    if (state.remaining <= 0) {
      state.enabled = false;
      writeState(state);
      if (ctx.hasUI) ctx.ui.setStatus("auto-continue", "已停（次数用尽）");
      return;
    }
    if (goalDone()) {
      state.enabled = false;
      writeState(state);
      if (ctx.hasUI) ctx.ui.setStatus("auto-continue", "已完成");
      return;
    }
    const text = textOf(event.message);
    if (text.includes("<promise>COMPLETE</promise>")) {
      state.enabled = false;
      writeState(state);
      if (ctx.hasUI) ctx.ui.setStatus("auto-continue", "已完成");
      return;
    }

    state.remaining -= 1;
    writeState(state);
    if (ctx.hasUI) ctx.ui.setStatus("auto-continue", `续跑中 · 剩 ${state.remaining}`);

    // 关键一步：投递下一条指令，pi 立刻开启下一轮。
    // 优先用 sendUserMessage（会立刻起一轮）；万一不可用再退回 continue:true。
    try {
      // 必须带 streamingBehavior：turn_end 时 agent 仍处于处理中，
      // 不带这个参数会抛 "Agent is already processing"。followUp = 排队到本轮之后。
      await pi.sendUserMessage(state.prompt, { streamingBehavior: "followUp" });
      return;
    } catch {
      return { continue: true };
    }
  });

  pi.registerCommand("auto", {
    description: "自动续跑：/auto on [轮数] | /auto off | /auto status",
    handler: async (args, ctx) => {
      const state = readState();
      const [sub, n] = (args ?? "").trim().split(/\s+/);
      if (sub === "off") {
        state.enabled = false;
        writeState(state);
        ctx.ui.notify("auto-continue 已关闭", "info");
        return;
      }
      if (sub === "on") {
        const turns = Math.min(Number(n) || 40, 200);
        state.enabled = true;
        state.remaining = turns;
        writeState(state);
        ctx.ui.notify(`auto-continue 已开启，最多续跑 ${turns} 轮`, "info");
        return;
      }
      if (sub === "set") {
        const turns = Math.min(Number(n) || 40, 200);
        state.enabled = turns > 0;
        state.remaining = turns;
        writeState(state);
        ctx.ui.notify(`auto-continue remaining=${turns}`, "info");
        return;
      }
      ctx.ui.notify(
        `auto-continue: ${state.enabled ? "on" : "off"} · remaining=${state.remaining}`,
        "info",
      );
    },
  });
}
