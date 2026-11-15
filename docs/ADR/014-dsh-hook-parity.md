# ADR-014 — dsh 端门控与 pi 端对齐（结果钩子与轮次级门控）

- 状态：已采纳
- 日期：2026-11-15
- 取代：`docs/ADR/011-ai4s-domain-gates.md` 中「dsh 拿不到用户 prompt」「只有 T0 可用」的结论；
  以及对 v5 适配层「dsh 没有结果钩子与轮次级注入」这一前提的所有引用
- 相关：ADR-003（硬闸门分层）、ADR-006（轮次级门控与证据过期）、ADR-012（破坏性三档）、ADR-013（bypass 模式）

---

## 背景

v5 的 dsh 适配层只挂了一个钩子 `tools/pre-execute`，并把这个限制写成了永久事实：

- `bridge/gates/dsh/policy.json` 的 `description` 宣告「dsh 没有结果钩子与轮次级注入」，
  因此 `graph_signal_requires_content: false`，`think-before-write` / `no-blind-retry` /
  `chg-contract-before-edit` 三条**故意不登记**；
- 适配层在**准入时**就 `recordSignal`、`recordInspection`，因为拿不到结果；
- `docs/USAGE.md`、`skills/agent-hard-gates/SKILL.md`、ADR-011 都按这个前提写了「dsh 不对称」。

2026-11-15 核对**当前安装版本**的文档与源码后确认：这些限制并不成立。

## 事实（实测出处）

| 能力 | dsh 机制 | 出处 |
|---|---|---|
| 工具最终结果，同步、冻结、含 `isError` | `tools/result` — `(exec, result)` | `docs/user/develop/framework/events.md`；`docs/tool-execution-pipeline.md` L25 |
| 结果类型判别 | `ToolExecutionResult = Success \| Failure`，`isError` 判别 | `docs/subsystems/tools.md` L492–523 |
| 轮次关闭前钩子，可 steer 续跑 | `agent/turn-stopping` — serial，`{agent, turn, signal}` | `docs/subsystems/core.md` L1090–1119 |
| 步骤准入，可见已领取的 `UserMessage[]` | `agent/pre-step` — waterfall | 同上 L1012–1036、L383–397 |
| 模型可见上下文注入 | `agent.inject(message: UserMessage)` | 同上 L143；`docs/architecture.md` L161 |
| 询问决策 | `{kind:'ask'}` → `ctx.approval`，仅 `allowed-once` 放行 | `docs/subsystems/tools.md` L543–572；`docs/subsystems/approval.md` L33 |
| 增量 fold 而非重扫日志 | 性能纪律 | `docs/subsystems/practices.md` L26 |

## 决定

1. **图谱通行证改由结果判定。** `recordSignal` 只出现在 `tools/result`，且必须先过
   `graphResultIsEvidence(正文, config)`。准入时不再记信号 —— 那是 `{"total":0}` 能换来读窗口的洞。
2. **Layer 0 读证据保留在准入级。** 通行证走严格路径，宽松证据走宽容路径：万一结果钩子在某次升级后失效，
   Layer 0 仍工作、Layer 1 变严格（**显式失败**），不会静默放行。
3. **轮次级不偷懒接入 `agent/turn-stopping`。** 该钩子的契约是「监听器用 `agent.steer()` 表达异议」，
   不是返回值，所以 pi 的 `return {continue:true}` 在这里变成一次 steer 副作用。
   最终文本从 `session/event` 的 `assistant/message` **增量 fold**（`practices.md` 禁止重扫全量）。
4. **分类与提醒接入 `agent/pre-step`。** `payload.messages` 就是用户这条消息，分类器第一次拿到真实 prompt；
   提醒按「每轮一次」去重后经 `agent.inject()` 注入。
5. **`ask` 先问「有没有人能答」。** 只有 `ctx.approval.effectivePolicy(session) === 'ask'` 才返回
   `{kind:'ask'}`；审批关闭或服务缺失时**维持既有的放行 + stderr 一行**。理由见下。
6. **`policy.json` 如实声明。** 三条检查重新登记，`graph_signal_requires_content` 置 `true`。

## 取舍与代价

### 为什么 `ask` 不能无条件返回

`PreToolDecision.ask` 的语义是「只有审批返回 `allowed-once` 才执行，否则**拒绝**」。
在审批策略为 `never` 或服务缺失的会话里，无条件返回 `ask` 等于把每一条可恢复删除变成永久拒绝 ——
**门控把 agent 焊死**，这是本设计最要避免的失败模式（ADR-008）。
所以先探测通道，能答才问；不能答就按 pi 的「no UI」分支同样处理：放行并**在 stderr 留下痕迹**。
代价：无人值守时一次性删除不经确认 —— 与 pi 在无 UI 环境下的行为一致，且红线档 `high` 仍然硬拦。

### 为什么最终文本靠缓存而不是反查

`agent/turn-stopping` 只给 `{agent, turn, signal}`。反查 `session.events` 会让每轮的代价随会话长度增长；
`agent/assistant-stream` 只覆盖直播流，重放/恢复场景拿不到。增量 fold 是唯一同时满足正确性与
`practices.md` 性能纪律的选择。代价：**纯工具轮没有 assistant 文本时不判定** —— 宁可漏判，不误伤。

### 为什么 steering 消息形状要试探

`Followup/inject/steer` 都收 `UserMessage`，而正确构造它的工厂 `@deepseek-ai/dsh-llm` 不是本插件的声明依赖
（CONTRIBUTING：不新增依赖）。适配层因此按文档化的形状逐个尝试，全部被拒时**只写一行 stderr**，
绝不抛 —— `agent/turn-stopping` 在轮次边界被 await，抛出去会让整轮失败。
这是一个**已知的未验证点**，记录在 `tasks/CHG-20261115-dsh-gate-parity/TRACEABILITY.md` §C。

## 后果

- 两端共用同一个 `policy.js`，判定逻辑零分叉；差异只剩「机制怎么表达」。
- dsh 端的 `checks` 数组与 pi 端一致（10 条）。
- 新增三条能变红的测试类别：空结果/失败结果不算证据、轮次级延期承诺会被 steer、confirm 档按审批通道分化。
- 文档与技能里的「dsh 不对称」措辞全部改写为「已对齐 + 残留机制差异」。ADR-011 作为历史记录不修改，
  其结论以本 ADR 为准。
