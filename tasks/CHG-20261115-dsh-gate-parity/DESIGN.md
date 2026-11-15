# DESIGN：dsh 钩子映射与实现取舍

- change_id: CHG-20261115-dsh-gate-parity
- ADR: `docs/ADR/014-dsh-hook-parity.md`

---

## 1. 钩子映射表（pi → dsh）

| pi 事件 | dsh 机制 | 模式 | payload | 本 CHG 用法 |
|---|---|---|---|---|
| `tool_call` | `tools/pre-execute` | waterfall | `(exec, next)` | 已有；新增 `ask` 决策 |
| `tool_result` | `tools/result` | emit（同步） | `(exec, result)` | **新增**：证据记账的唯一真实来源 |
| `turn_end` | `agent/turn-stopping` | serial | `{agent, turn, signal}` | **新增**：不偷懒 + AI4S 产出物 |
| `before_agent_start` | `agent/pre-step` | waterfall | `{agent, messages, turn, step, signal}` | **新增**：turnStart / 分类 / 提醒 |
| `context`（注入提醒） | `agent.inject({content, source})` | 命令式 | — | **新增**：在 pre-step 注入 |
| `ctx.ui.select/confirm` | `{kind:'ask'}` + `ctx.approval` | waterfall 决策 | — | **新增**：破坏性 confirm 档 |
| `registerCommand('gate')` | 已有（`dsh` 命令包，commit 519ac66） | — | — | 复用，不改 |

## 2. 关键取舍

### 2.1 为什么图谱信号改为结果级、而读证据仍留在准入级

- **图谱信号**是「可以读源码」的通行证。准入级记录等于「只要你调了这个工具名就放行」——
  这正是 ADR-006 记的「空结果不算合规」要堵的洞。必须等结果，且必须判内容。
- **读证据**（`recordInspection`）服务的是 Layer 0「改前是否读过」。准入后被拦的可能性已排除，
  且读失败（文件不存在）属边缘情形。留在准入级可降低对 `tools/result` 的硬依赖——
  万一结果钩子失效，Layer 0 仍工作，只有 Layer 1 变严格（显式失败，不是静默放行）。

结论：**通行证走严格路径，宽松证据走宽容路径。** 二者都不静默。

### 2.2 轮次收尾怎么拿到「最终文本」

pi 的 `turn_end` payload 带 `event.message`。dsh 的 `agent/turn-stopping` 只给
`{agent, turn, signal}` —— **没有文本**。

方案对比：

| 方案 | 做法 | 代价 |
|---|---|---|
| A. 订阅 `session/event` 增量缓存最后一条 `assistant/message` | 每事件 O(1) 更新一个字符串 | 一个监听器 + 一个 Map |
| B. turn-stopping 时反查 `agent.session.events` | 无缓存 | 每轮扫全量事件，长会话退化 |
| C. 用 `agent/assistant-stream` 累积 | 只覆盖直播流 | 重放/恢复场景拿不到 |

选 **A**。`docs/subsystems/practices.md`「Performance」明确要求「不要把 `session/event` 订阅
+ 全量重扫」，但允许增量 fold；A 正是增量。

缓存按 `session` 键，存最近一条 assistant 文本；turn-stopping 里读它。

### 2.3 怎么「强制继续一轮」

`agent/turn-stopping` 的契约：监听器**不返回**决策，而是 `agent.steer(...)`；
机器随后重读 inbox——有 fresh steering 就跑下一步，没有才关轮。

因此：`agent.steer(userMessage)` + 计数自增。不是返回值，是副作用。
这决定了它**不能**像 pi 那样 `return { continue: true, entries: [...] }`。

构造 `UserMessage` 需要合法形状。为避免依赖内部 helper（`createUserMessage` 属 `@deepseek-ai/dsh-llm`，
本插件不声明该依赖），适配层用一个**最小可接受形状**并做 capability 探测：
若 `agent.steer` 不存在或抛出，则退化为 stderr 一行告警，绝不因此让轮次崩溃。

### 2.4 破坏性 confirm：先问「有没有审批通道」再决定

`PreToolDecision` 的 `ask` 语义：只有 `ctx.approval` 返回 `allowed-once` 才执行，
否则**拒绝**。在 `approval` 策略为 `never` 或服务缺失的会话里，无条件返回 `ask`
等于把 `rm -rf build` 变成永久拒绝——门控把 agent 焊死，这是本设计最要避免的失败模式。

所以：

```
confirm 判定
  ├─ ctx.approval 可用 且 effectivePolicy(session) === 'ask'
  │     → return { kind: 'ask', reason, displayReason }
  └─ 否则
        → return next()      // 与 pi 的 no-UI 分支一致
          + process.stderr.write('[enforce-rules] DESTRUCTIVE_CONFIRM auto-approved (no approval channel): ...')
```

`high` 档不受此影响，永远 `deny`。

### 2.5 域分类的 prompt 来源

`agent/pre-step` 的 `payload.messages` 是本步**已领取**的 `UserMessage[]`。
「首次提案」那一步就是用户这条消息。取其中的文本拼接作为 `prompt`，
喂给既有 `classify({cwd, prompt, fs, policy, modelHint})` —— 分类器一行不改。

去重键：`${cwd}\0${turn}`。同一 turn 内不重复分类。

## 3. 数据流（改后）

```
用户消息
  └─ agent/pre-step ──┬─ 记 turnStart（turn 变化时）
                      ├─ classify(prompt) → state.profile
                      └─ agent.inject(reminderFor(...))   每轮一次
  └─ tools/pre-execute ─┬─ 写/读/bash 判定 → deny | ask | next()
                        ├─ 准入级记读证据（Layer 0，宽松）
                        └─ 不记图谱信号（改由 result 记）
        └─ 工具执行
              └─ tools/result ─┬─ 成功读 → recordInspection / recordDocRead
                               ├─ 成功 shell → recordCommandResult(false) + shellReadTargets
                               ├─ 失败 shell → recordCommandResult(true)  → 触发盲重试规则
                               ├─ 索引工具 → resetMtimeCache + recordIndexRefresh
                               └─ 图谱工具 → graphResultIsEvidence ? recordSignal + recordUnlocks
  └─ agent/turn-stopping ─┬─ outputArtifactFindings 非空 → steer
                          └─ slackFinding 命中         → steer
```

## 4. 既有债务（不在本 CHG 修）

- `policy.js` 约 3300 行、单文件承载；本 CHG 一行不改。
- dsh 适配层与 pi 适配层有约 60 行重复的 `realFs` 探测；抽公共模块属独立重构。
- `agent/turn-stopping` 的文本来自缓存，若某平台不发 `assistant/message`（例如纯工具轮），
  缓存为空 → 不判定，属可接受的漏判（不误伤）。
