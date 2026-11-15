# CHANGE：DSH 端门控与 pi 端对齐（补齐结果钩子与轮次级门控）

- change_id: CHG-20261115-dsh-gate-parity
- 提出人: Owner
- 提出时间: 2026-11-15
- 状态: approved

---

## 0.1 原始需求（Owner 原话，节选）

> pi agent 的那套硬门控插件，你 dsh 也需要，动脑子、codebase mcp 优先、不偷懒，这些都是应该被继承的。
> 你看这个项目中 pi agent 有的部分，查漏补缺，在 dsh 中都加上。

## 0.2 现状审计（实测）

| 事实 | 证据 |
|---|---|
| dsh 适配层只有 `tools/pre-execute` 一个钩子 | `bridge/gates/dsh/index.js` 全文仅 1 处 `ctx.on(...)` |
| 图谱证据一律放行，未校验结果有无内容 | 同文件 `isSignalTool` 分支在**准入时**即 `recordSignal` |
| 读证据在准入时提前记账 | 同文件 `READ_TOOLS` 分支 `recordInspection` 后 `return next()` |
| 无轮次级门控 | 无 `agent/turn-stopping` 监听；`slackFinding` / `outputArtifactFindings` 从未被 dsh 调用 |
| 无每轮提醒 | 无 `agent.inject()` / `ctx.systemPrompt.section()` 调用；`reminderFor` 从未被 dsh 调用 |
| 无域分类输入 | 注释自述「dsh 没有 prompt」，`classify` 传入 `prompt: ''` |
| 破坏性 confirm 档降级为直接执行 | 注释：「dsh 的 pre-execute 暴露 only deny 和 next」 |
| dsh policy.json 主动关闭了三条检查 | `graph_signal_requires_content: false`；`think-before-write` / `no-blind-retry` / `chg-contract-before-edit` 未登记 |
| 技能文档据此宣称「dsh 不对称」 | `skills/agent-hard-gates/SKILL.md`「dsh 不对称」节 |

**结论（根因）**：v5 适配层写于「dsh 只有 pre-execute」的认知下，并把这个认知固化进了
policy.json 的注释、技能文档和 ADR 措辞。而**当前安装的 dsh 版本实际提供了**：

| 能力 | dsh 事件 | 实测出处 |
|---|---|---|
| 工具最终结果（含 `isError` / `content`） | `tools/result` — `(exec, result)`，同步、冻结后通知 | `docs/user/develop/framework/events.md` §"Cordis events and session records"；`docs/tool-execution-pipeline.md` |
| 轮次关闭前钩子（可 steer 续跑） | `agent/turn-stopping` — serial，payload `{agent, turn, signal}` | `docs/subsystems/core.md` `agent/turn-stopping` 签名块 |
| 步骤准入（可见已领取的 `UserMessage[]`，即用户提示词） | `agent/pre-step` — waterfall | 同上 `agent/pre-step` 签名块 |
| 模型可见上下文注入 | `agent.inject({content, source})`，下一次获准请求可见 | `docs/architecture.md`「添加模型可见上下文」 |
| 审批询问通道 | `tools/pre-execute` 返回 `{kind:'ask'}`，由 `ctx.approval` 应答 | `docs/subsystems/tools.md` `PreToolDecision`；`docs/subsystems/approval.md` |

**这不是 dsh 的能力缺失，是适配层认知过期。**

## 0.3 目标形态

```
pi  的每一条门控  →  dsh 都有对应机制
  结果级（图谱证据/盲重试/读证据）  →  tools/result
  轮次级（不偷懒/AI4S 产出物）      →  agent/turn-stopping + agent.steer()
  轮次开始（分类/提醒/turnStart）    →  agent/pre-step + agent.inject()
  询问级（破坏性 confirm）          →  pre-execute 返回 ask + ctx.approval
```

**判据**：每补一条，都必须有一条**能变红**的测试；dsh 的 policy.json 不再声明
「本端不支持」，而是声明「本端已支持」。

---

## 1. 范围

### In Scope
- `bridge/gates/dsh/index.js`：新增 `tools/result` / `agent/pre-step` / `agent/turn-stopping` 三个监听器；
  `tools/pre-execute` 增加 `ask` 决策；图谱证据改为「结果有内容才算」
- `bridge/gates/dsh/policy.json`：登记此前被关闭的检查，`graph_signal_requires_content` 打开
- `bridge/test/gate-dsh.test.js`：为每个新钩子补能变红的用例
- 新增 ADR 记录 dsh 钩子映射
- `skills/agent-hard-gates/SKILL.md`、`README.md`、`docs/USAGE.md`：修正「dsh 不对称」措辞

### Out of Scope
- 不改 `bridge/gates/policy.js`（策略层判定逻辑一行不动）
- 不改 pi 适配层
- 不改 dsh 主程序、不改 profile 的 `package.json` / `cordis.patch.yml`
- 不引入第三方依赖

## 2. 风险与对策

| 风险 | 对策 |
|---|---|
| `tools/result` 若在真实环境不触发，Layer 1 会把所有源码读都拦死 | 两条证据路径并存：`pre-execute` 记录**读**动作（Layer 0，宽松），只有**图谱信号**改为结果级（严格）。图谱信号另有 `signal_ttl_ms`，且失败落 stderr 告警 |
| `agent/turn-stopping` 误判导致永不收尾 | 复用既有 `slack_max_continues` 上限（<=0 直接不启用）；steer 内容带明确指令，不是无限续跑 |
| 返回 `ask` 在审批关闭（`never`）的会话里会把破坏性命令全拒死 | 先读 `ctx.approval.effectivePolicy(session)`：`ask` 才返回 `{kind:'ask'}`；`never`/服务缺失时**维持既有权衡**（放行 + stderr 一行），与 pi 的 no-UI 分支一致 |
| 每次工具调用都跑 `tools/result`，拖慢 | 只做 Map 写入与已编译正则；无 IO、无 await |
| 每个 step 都跑 `agent/pre-step`，重复注入提醒 | 分类与提醒各按「每轮一次」去重（比对 `payload.turn`） |

## 3. 成功判据

1. `node --test` 全绿（含新增用例）
2. 新增用例逐条**能变红**：注释中写清「注释掉哪一行会怎样红」
3. `bridge/gates/dsh/policy.json` 的 `checks` 含 `think-before-write` / `no-blind-retry` / `graph-before-read`
   且 `graph_signal_requires_content` 为 `true`
4. 空图谱结果（`{"total":0}`）**不能**换来读窗口
5. 轮次收尾时若最终文本是「我稍后再补」这类拖延承诺，`agent/turn-stopping` 会 steer 一轮，且次数受上限约束
6. `bash scripts/scan-secrets.sh --history` 无命中
7. 三段语法检查通过（`node --check` 遍历 `bridge/**/*.js`）
