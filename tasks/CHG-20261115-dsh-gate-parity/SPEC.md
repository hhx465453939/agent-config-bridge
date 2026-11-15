---
change_id: CHG-20261115-dsh-gate-parity
version: 1
status: approved
prd_ref: PRD.md
created: 2026-11-15
owner: dsh
---

# SPEC-20261115 · DSH 端门控与 pi 端对齐

## 1. 目标（可判定终态）

1. **图谱信号结果级**：`recordSignal` 只在 `tools/result` 中、且 `graphResultIsEvidence(文本, config)` 为真时调用；
   `tools/pre-execute` 的 `isSignalTool` 分支**不再**记录信号。
2. **空结果不算**：`{"total":0}` / `{"results":[]}` / `{"has_more":false}` 之类结果不换来读窗口
   （由既有 `graphResultIsEvidence` 负责，本 CHG 只负责「把它接上」）。
3. **轮次级不偷懒**：`agent/turn-stopping` 监听器在 `policy.config.slack_max_continues > 0` 时，
   用缓存到的本轮最终 assistant 文本调 `slackFinding(text, config)`；命中则 `agent.steer()` 并计数。
4. **上限可红**：`state.slackContinues >= slack_max_continues` 后不再 steer；
   `slack_max_continues <= 0` 时完全不启用（默认行为不变）。
5. **AI4S 产出物**：同一监听器内先跑 `outputArtifactFindings(...)`，非空则 steer。
6. **读证据真实**：`tools/result` 中成功读才 `recordInspection`；成功 shell 走 `shellReadTargets` 记 inspection，
   并像 pi 一样对 `cat <convention doc>` 记 `recordDocRead`。
7. **盲重试**：失败 shell 走 `recordCommandResult(state, command, true)`。
8. **索引证据**：`index_repository` / `detect_changes`（含 `_` 前缀变体）成功时 `resetMtimeCache()` + `recordIndexRefresh()`。
9. **每轮一次的分类与提醒**：`agent/pre-step` 中按 `${cwd}\0${turn}` 去重；分类输入为本步 `messages` 的文本；
   `reminderFor(policy, state)` 非空时 `agent.inject({content, source})` 注入一次。
10. **turnStart**：turn 号变化时写 `state.turnStart = Date.now()`（W2 mtime 基准）。
11. **破坏性 confirm 走审批**：`verdict.confirm` 且 `ctx.approval` 可用且 `effectivePolicy(session) === 'ask'`
    → `return { kind: 'ask', reason, displayReason }`；否则 `return next()` 并向 stderr 写一行
    `[enforce-rules] DESTRUCTIVE_CONFIRM auto-approved (no approval channel): <command 前 200 字>`。
    `high` 档仍 `{ kind: 'deny' }`。
12. **policy 声明如实**：`bridge/gates/dsh/policy.json` 的 `checks` 增加
    `think-before-write`、`no-blind-retry`、`chg-contract-before-edit`；`graph_signal_requires_content` 置 `true`；
    `description` 不再宣称「dsh 没有结果钩子 / 无轮次级注入」。
13. **兼容**：`bridge/gates/dsh/index.js` 在缺少任一服务（`approval` / `workingDirectory`）时不得抛错，
    且不得整体停用门控。
14. **文档如实**：`skills/agent-hard-gates/SKILL.md` 的「dsh 不对称」段改为「两端对齐 + 残留差异清单」。

## 2. 架构与债务

- 延续 ADR-003 分层：**判定仍全在 `policy.js`**，本 CHG 只加适配层的钩子与记账。
  `bridge/gates/policy.js` 一行不改。
- 新增状态：`state.slackContinues` 已在 `newSessionState()` 中存在（pi 端在用），直接复用，不新增字段。
- 新增适配层局部状态：`lastAssistantText`（Map<session, string>）、`lastPreStepKey`、`classified` 语义扩展。
- 已知债务（不在本 CHG 修）：两适配层的 `realFs` 重复实现、`policy.js` 体量。

## 3. 选定设计与 ADR

- ADR：`docs/ADR/014-dsh-hook-parity.md`。
- 「最终文本」来源：增量订阅 `session/event`，只 fold `assistant/message`，按 session 缓存。
- 「强制继续」：`agent.steer(UserMessage)`，不是返回值；steer 失败只告警不抛。
- 「有没有审批通道」：`ctx.approval.effectivePolicy(session) === 'ask'`。

## 4. 验收命令

```bash
# 1. 语法
for f in $(find bridge -name '*.js'); do node --check "$f" || exit 1; done

# 2. 单测（新增用例必须能红，注释里写明破坏方式）
node --test

# 2b. 只跑 dsh 适配层
node --test bridge/test/gate-dsh.test.js

# 3. 敏感内容
bash scripts/scan-secrets.sh --history
```

## 5. 交付清单（清单外不建文件）

| 路径 | 类型 |
|---|---|
| `bridge/gates/dsh/index.js` | 修改 |
| `bridge/gates/dsh/policy.json` | 修改 |
| `bridge/test/gate-dsh.test.js` | 修改（追加用例，原有 8 条不动） |
| `bridge/test/gates.test.js` | 修改（2 条 dsh 用例的契约从「查了就放行」改为「有结果才放行」——旧断言编码的正是本 CHG 推翻的前提） |
| `bridge/test/gate-policy.test.js` | 修改（1 条 shipped-policy 断言：dsh 不再享受 `graph_signal_requires_content: false` 的豁免） |
| `docs/ADR/014-dsh-hook-parity.md` | 新建 |
| `tasks/CHG-20261115-dsh-gate-parity/{CHANGE,PRD,DESIGN,SPEC,TRACEABILITY}.md` | 新建 |
| `skills/agent-hard-gates/SKILL.md` | 修改（不对称段） |
| `README.md` | 修改（dsh 端能力描述） |
| `docs/USAGE.md` | 修改（同上） |

> 超出初始清单的两条测试文件是**发现性问题**：它们把「dsh 看不到结果」写成了断言，
> 不改则契约变更无法落地。已在此处登记，并逐条说明改的是**断言而非被测行为**。


## 6. 回归保护

- pi 适配层、`policy.js`、bootstrap/install 脚本、targets 清单：**零改动**
- 既有 8 条 `gate-dsh.test.js` 用例语义不变
- 其余测试文件语义不变
