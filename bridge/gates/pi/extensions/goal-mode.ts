/**
 * goal-mode —— pi 长任务「目标驱动」扩展（带预算与空转保护）。
 *
 * 与同目录 `auto-continue.ts` 的关系：
 *   - auto-continue：`turn_end` 边界，**无轮数上限**，靠 `state: DONE` 或
 *     `<promise>COMPLETE</promise>` 停机。适合你已经把目标写进 tasks/ 的里程碑流程。
 *   - goal-mode：`agent_before_settle` 边界，**带预算**（默认 400 轮 / 12 小时）
 *     和**空转检测**（连续 3 轮没有任何工具调用就停），并由模型显式调用
 *     `goal_complete` 工具宣告完成。适合"给一句话目标，让它自己跑到完"。
 *
 * **二选一，不要同时开启。** 两个扩展默认都是关闭状态；同时 `/auto on` 和
 * `/goal ...` 会让两条续跑逻辑叠加，行为不可预测。
 *
 * 状态文件：`<项目>/.pi/goal-state.json`（运行时产物，建议 gitignore）。
 *
 * 依赖说明：`typebox` 由 pi 运行时提供（pi 自身依赖），本仓库不新增依赖；
 * 与 `auto-continue.ts` 只 import `@earendil-works/pi-coding-agent` 同理。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STATE_REL = ".pi/goal-state.json";
/** 连续多少轮「零工具调用」判定为空转 */
const MAX_IDLE_STREAK = 3;
/** 两次 settle 间隔小于此值视为同一次收工的重复触发 */
const SETTLE_DEBOUNCE_MS = 800;

type GoalStatus = "idle" | "running" | "done" | "stopped";

interface GoalState {
	active: boolean;
	status: GoalStatus;
	prompt: string;
	iteration: number;
	maxIterations: number;
	startedAt: number;
	maxHours: number;
	idleStreak: number;
	toolsThisRound: number;
	lastSettleAt: number;
	stopReason?: string;
}

function freshState(): GoalState {
	return {
		active: false,
		status: "idle",
		prompt: "",
		iteration: 0,
		maxIterations: 400,
		startedAt: 0,
		maxHours: 12,
		idleStreak: 0,
		toolsThisRound: 0,
		lastSettleAt: 0,
	};
}

function statePath(): string {
	return join(process.cwd(), STATE_REL);
}

function loadState(): GoalState {
	try {
		const raw = readFileSync(statePath(), "utf8");
		return { ...freshState(), ...(JSON.parse(raw) as Partial<GoalState>) };
	} catch {
		return freshState();
	}
}

function saveState(state: GoalState): void {
	try {
		const file = statePath();
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf8");
	} catch {
		/* 只读目录等场景下降级为内存态，不影响本轮续跑 */
	}
}

function fmtDuration(ms: number): string {
	const totalMin = Math.max(0, Math.floor(ms / 60_000));
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return h > 0 ? `${h}h${m}m` : `${m}m`;
}

export default function goalModeExtension(pi: ExtensionAPI) {
	let state = loadState();
	// 上一次进程留下的 active 状态不自动接管，避免意外续跑；等用户 /goal 再决定
	if (state.active) {
		state = {
			...state,
			active: false,
			status: "stopped",
			stopReason: "进程重启，状态已暂停（用 /goal 查看）",
		};
		saveState(state);
	}

	const remainingIterations = () => state.maxIterations - state.iteration;
	const deadline = () => state.startedAt + state.maxHours * 3_600_000;

	const stop = (reason: string) => {
		state.active = false;
		state.status = "stopped";
		state.stopReason = reason;
		saveState(state);
	};

	const complete = (reason: string) => {
		state.active = false;
		state.status = "done";
		state.stopReason = reason;
		saveState(state);
	};

	// 让模型能显式宣告「真的做完了」，比文本标记可靠
	pi.registerTool({
		name: "goal_complete",
		label: "Goal Complete",
		description:
			"Call this ONLY when the entire active goal is finished AND verified. Do not call it to report partial progress, a plan, or a blocker.",
		promptSnippet: "Mark the active goal loop as fully complete (goal mode only).",
		parameters: Type.Object({
			summary: Type.String({
				description: "Final summary: what was delivered, what was verified, and any residual risk.",
			}),
		}),
		async execute(_toolCallId, params) {
			complete(params.summary);
			return {
				content: [
					{
						type: "text" as const,
						text: `Goal loop marked complete. Relay the final report to the user now. Summary recorded: ${params.summary}`,
					},
				],
				details: { goalStatus: "done" },
			};
		},
	});

	// 统计本轮工具调用，用于空转检测
	pi.on("tool_execution_end", () => {
		state.toolsThisRound += 1;
	});

	// 核心：收工前拦一道，没完成就继续
	pi.on("agent_before_settle", async (event) => {
		if (!state.active) return;

		// 用户按 Esc / Ctrl-C 中止：尊重用户，绝不自动续跑
		if (event.outcome === "aborted") {
			stop("用户手动中止");
			return;
		}

		const now = Date.now();
		if (now - state.lastSettleAt < SETTLE_DEBOUNCE_MS) return;
		state.lastSettleAt = now;

		if (state.iteration >= state.maxIterations) {
			stop(`达到最大续跑轮数 ${state.maxIterations}`);
			return;
		}
		if (now >= deadline()) {
			stop(`达到最长运行时长 ${state.maxHours} 小时`);
			return;
		}

		// 空转检测：连续多轮一个工具都没调，说明模型在空谈或卡死
		if (state.toolsThisRound === 0) state.idleStreak += 1;
		else state.idleStreak = 0;
		if (state.idleStreak >= MAX_IDLE_STREAK) {
			stop(`连续 ${MAX_IDLE_STREAK} 轮没有执行任何工具，判定为空转`);
			return;
		}

		state.iteration += 1;
		state.toolsThisRound = 0;
		saveState(state);

		const elapsed = fmtDuration(now - state.startedAt);
		const content = [
			`[GOAL MODE · 第 ${state.iteration}/${state.maxIterations} 轮 · 已跑 ${elapsed}]`,
			``,
			`目标：${state.prompt}`,
			``,
			`继续执行，不要停。硬性要求：`,
			`1. 不要复述计划、不要询问确认、不要输出「我将要 / 接下来准备 / 是否需要我」。`,
			`2. 这一轮必须至少调用一次工具，实际推进任务。`,
			`3. 一部分做完就接着做下一部分，直到目标全部达成且自检通过。`,
			`4. 只有全部完成时才调用 goal_complete 工具，然后给出最终报告。`,
			`5. 如果遇到真实阻塞（缺凭据、外部服务故障），把阻塞点写清楚并在报告里说明，不要假装完成。`,
			``,
			`剩余预算：${remainingIterations()} 轮 / 约 ${fmtDuration(Math.max(0, deadline() - now))}。`,
		].join("\n");

		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: "goal-mode-continue",
					content,
					display: false,
				},
			],
			continue: true,
		};
	});

	// 全部收工后再通知，避免中止/重试时误报
	pi.on("agent_settled", async (_event, ctx) => {
		if (state.status === "done") {
			ctx.ui.notify(`目标已完成：${state.stopReason ?? "无摘要"}`, "info");
		} else if (state.status === "stopped") {
			ctx.ui.notify(`目标循环已停止：${state.stopReason ?? "未知原因"}`, "warning");
		}
	});

	pi.registerCommand("goal", {
		description:
			"目标模式：持续驱动任务直到完成。用法 /goal <任务> | /goal | /goal done | /goal stop | /goal max <n> | /goal hours <n>",
		getArgumentCompletions: (prefix) => {
			const subs = ["done", "stop", "max", "hours", "status"];
			const hits = subs.filter((s) => s.startsWith(prefix.trim()));
			return hits.length > 0 ? hits.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();
			const [head, ...rest] = input.split(/\s+/);
			const tail = rest.join(" ").trim();

			if (!input || head === "status") {
				if (!state.active && state.status === "idle") {
					ctx.ui.notify("目标模式未启动。用 /goal <任务描述> 开始。", "info");
					return;
				}
				const lines = [
					`状态：${state.status}${state.active ? "（运行中）" : ""}`,
					state.prompt ? `目标：${state.prompt}` : "",
					`轮次：${state.iteration}/${state.maxIterations}`,
					state.startedAt
						? `已运行：${fmtDuration(Date.now() - state.startedAt)} / 上限 ${state.maxHours}h`
						: "",
					state.stopReason ? `最近原因：${state.stopReason}` : "",
				].filter(Boolean);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (head === "done") {
				complete(tail || "用户手动标记完成");
				ctx.ui.notify("已标记目标完成，停止续跑。", "info");
				return;
			}

			if (head === "stop" || head === "pause") {
				stop(tail || "用户手动停止");
				ctx.ui.notify("已停止目标循环（任务可稍后用 /goal 重新启动）。", "warning");
				return;
			}

			if (head === "max") {
				const n = Number.parseInt(tail, 10);
				if (!Number.isFinite(n) || n < 1) {
					ctx.ui.notify("用法：/goal max <正整数>", "warning");
					return;
				}
				state.maxIterations = n;
				saveState(state);
				ctx.ui.notify(`最大续跑轮数已设为 ${n}`, "info");
				return;
			}

			if (head === "hours") {
				const n = Number.parseFloat(tail);
				if (!Number.isFinite(n) || n <= 0) {
					ctx.ui.notify("用法：/goal hours <小时数>", "warning");
					return;
				}
				state.maxHours = n;
				saveState(state);
				ctx.ui.notify(`最长运行时长已设为 ${n} 小时`, "info");
				return;
			}

			// 其余一律当作任务描述，启动目标模式
			const prompt = input;
			state = { ...freshState(), active: true, status: "running", prompt, startedAt: Date.now() };
			saveState(state);

			ctx.ui.notify(`目标模式启动：${prompt}`, "info");
			await pi.sendUserMessage(
				[
					`[GOAL MODE 启动] 目标：${prompt}`,
					``,
					`从现在开始持续执行，直到目标完成。规则：`,
					`- 不要输出计划后就停下，也不要询问确认；每一步直接调用工具去做。`,
					`- 每轮结束前检查：目标是否真的全部达成？没达成就继续下一项。`,
					`- 全部达成并验证后，调用 goal_complete 工具，然后给出最终报告。`,
				].join("\n"),
				{ deliverAs: "followUp" },
			);
		},
	});
}
