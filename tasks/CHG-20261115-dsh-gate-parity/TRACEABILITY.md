# TRACEABILITY：DSH 端门控对齐

## 需求 → 契约 → 产物 追溯

| 需求 / 判据 | SPEC 条款 | 产物 | 验收方式 | 状态 |
|---|---|---|---|---|
| 图谱信号结果级、空结果不算 | §1.1 / §1.2 | `bridge/gates/dsh/index.js` `tools/result` | `gate-dsh.test.js`「空图谱结果换不来读窗口」 | 待验 |
| 轮次级不偷懒 | §1.3 / §1.4 | 同上 `agent/turn-stopping` | 「拖延承诺会 steer 一轮」+「达上限后不再 steer」 | 待验 |
| AI4S 产出物 | §1.5 | 同上 | 既有 `outputArtifactFindings` 接入（受 profile 控制，用例用注入 profile） | 待验 |
| 读证据真实 | §1.6 | 同上 `tools/result` | 「读成功才留证据」 | 待验 |
| 盲重试 | §1.7 | 同上 | 「同一命令第 3 次原样重试被拦」 | 待验 |
| 索引证据 | §1.8 | 同上 | 「索引刷新后才放过新代码」 | 待验 |
| 每轮分类与提醒 | §1.9 / §1.10 | `agent/pre-step` | 「分类输入含用户提示词」「提醒每轮只注入一次」 | 待验 |
| 破坏性 confirm 走审批 | §1.11 | `tools/pre-execute` | 「审批可用 → ask；不可用 → next + stderr」 | 待验 |
| policy 声明如实 | §1.12 | `bridge/gates/dsh/policy.json` | 直接读文件断言 | 待验 |
| 服务缺失不崩 | §1.13 | 适配层 | 既有「无 service 也不 block」用例 + 新增 approval 缺失用例 | 待验 |
| 文档如实 | §1.14 | SKILL / README / USAGE | 人工核对 + 关键词断言 | 待验 |

## 独占清单核对（防越界）

- [x] `bridge/gates/dsh/index.js` — 仅本 CHG 修改
- [x] `bridge/gates/dsh/policy.json` — 仅本 CHG 修改
- [x] `bridge/test/gate-dsh.test.js` — 仅追加，不改既有 8 条
- [x] `bridge/gates/policy.js` — **零改动**
- [x] `bridge/gates/pi/index.js` — **零改动**

## A. 实测验收记录

环境：Node v24.22.1 / Windows；仓库 `main` @ `aae8c65`（改动前）。

| # | 命令 | 结果 | 退出码 |
|---|---|---|---|
| A-1 | `node --check` 遍历 `bridge/**/*.js`（共 41 个） | 全部通过，`syntax_failures=0` | 0 |
| A-2 | `node --test bridge/test/gate-dsh.test.js` | **21 项全过**（原 8 项 + 新增 13 项） | 0 |
| A-3 | `node --test`（全量） | **tests 352 / pass 350 / fail 0 / skipped 2** | 0 |
| A-4 | `bash scripts/scan-secrets.sh --history`（Git Bash 绝对路径，CONTRIBUTING 坑 4） | `scanned files: 148` / `OK: no sensitive content found` | 0 |
| A-5 | 改动前基线 | `fail 3` —— 三条失败均来自**旧前提的断言**，见 §D | 1 |

### 逐条 AC 对账

| 判据 | 用例 | 变红方式（注释已写进用例） |
|---|---|---|
| §1.1 / §1.2 结果级、空结果不算 | `read: ... only a RESULT opens the window` / `an empty graph result does NOT open the window` / `a failed graph query does NOT open the window` | 把 `tools/result` 里的 `graphResultIsEvidence` 判定去掉，或把 `recordSignal` 挪回 pre-execute |
| §1.6 读证据真实 | `evidence: admission is not evidence ...` / `a failed read result supplies nothing` | 让 `tools/result` 在 `isError` 时也记账 |
| §1.3 / §1.4 轮次级不偷懒 + 上限 | `a promise to finish later steers another step` / `the continue count is bounded` / `slack_max_continues 0 disables` / `a real delivery is left alone` / `reasoning content never counts` | 删掉 `agent/turn-stopping` 监听；或去掉 `state.slackContinues >= max` 判断 |
| §1.9 每轮一次提醒 | `pre-step: the reminder is injected once per turn and the step is admitted` | 去掉 `firstOfTurn` 去重（每步都注入）或干脆不注入 |
| §1.11 confirm 按通道分化 | `confirm: a recoverable delete asks when an approval channel exists` / `without an approval channel ... proceeds` / `never policy is treated as unavailable` | 无条件 `return {kind:'ask'}` → 第二、三条变红（审批关闭时全拒） |
| §1.12 policy 声明如实 | `gate-policy.test.js` shipped-policy 用例 | 把 dsh 的 `graph_signal_requires_content` 改回 `false` 即红 |
| §1.13 服务缺失不崩 | `cwd: without the service ...` + 上述 confirm 两条 | 去掉 `ctx.get?.()` 的防御 |
| §1.5 AI4S 产出物 | 复用 `outputArtifactFindings`（引擎侧已有独立用例） | 本 CHG 只做接线，未新增引擎用例；**如实声明**：该路径在 dsh 侧只有接线级覆盖，没有端到端用例 |

## B. 钩子来源（禁止编造的证明）

| 机制 | 来源文件（当前安装版本） | 取证方式 |
|---|---|---|
| `tools/result` `(exec, result)` 同步通知、冻结结果 | `docs/user/develop/framework/events.md` L104–138；`docs/tool-execution-pipeline.md` L25 | 读文档 + 全库有界字面量扫描（`dsh-action-cards` / `dsh-agent-instructions` 实际 `ctx.on('tools/result', …)`） |
| `ToolExecutionResult = Success \| Failure`（`isError` 判别） | `docs/subsystems/tools.md` L492–523 | 读类型块 |
| `PreToolDecision` 含 `ask` 与 `allow` | `docs/subsystems/tools.md` L543–558 | 读类型块 |
| `ask` 语义 = 仅 `allowed-once` 放行，否则拒绝 | 同上 L572 | 读正文 |
| `ctx.approval.effectivePolicy(session)` | `docs/subsystems/approval.md` L33 / L134–139 | 读正文 + `cordis-catalog` 签名块 |
| `agent/turn-stopping` serial、payload `{agent,turn,signal}`、以 `agent.steer()` 表达异议 | `docs/subsystems/core.md` L1090–1119 | 读签名块与 JSDoc |
| `agent/pre-step` waterfall、`payload.messages` 为已领取 `UserMessage[]` | `docs/subsystems/core.md` L1012–1036、L383–397 | 读签名块与 `PreStepDecision` |
| `agent.inject({content, source})` 下一次获准请求可见 | `docs/architecture.md` L161；`docs/cookbook/adding-a-tool.md` L50 | 读正文 |
| `session/event` 可观察 `assistant/message` | `docs/cookbook/extension-cookbook.md` L79–87 | 读示例代码 |
| 性能纪律：`session/event` 订阅不得全量重扫，应增量 fold | `docs/subsystems/practices.md` L26 | 读正文 |

## C. 与 pi 端的残留差异（改后仍需如实记录）

| 项 | pi | dsh 改后 | 是否可消除 |
|---|---|---|---|
| 提醒注入载体 | `context` 钩子改写 messages | `agent.inject()` 追加持久上下文 | 机制不同、效果等价 |
| 强制续跑表达 | `return {continue:true, entries}` | `agent.steer()` 副作用 | 机制不同、效果等价 |
| 询问 UI | `ctx.ui.select/confirm` 三选项 | `{kind:'ask'}` 二值（允许一次/拒绝） | **dsh 少「本会话允许这一类」选项**；用 `/gate` 命令补齐 |
| 分类模型判官 | `modelHint` 可注入 | 同（未接线，`model_judge:false`） | 等价 |
| 结果钩子失败时的降级 | 不适用 | Layer 0 仍工作、Layer 1 变严格 + stderr 告警 | 已有明示 |

## D. 自我纠错记录

1. **三次用例先红后改，每次都是真问题**
   - `an empty graph result does NOT open the window` 第一次红：测试策略没写 `graph_signal_requires_content`，
     引擎默认是 `false`。这暴露了一个真实认知：**该开关的默认值偏向宽松**，能防住它的只有
     `policy.json` 里的显式声明，所以 §1.12 的断言不是形式主义。
   - `pre-step: the reminder is injected once` 第一次红：`reminderFor` 读 `policy.reminded`，
     而 JSON 字段叫 `reminder`，由 `normalizePolicy` 归一。用例一开始写的是 `reminded` —— **我用错了键**。
   - `confirm: ... asks when an approval channel exists` 第一次红：目标放在 `os.tmpdir()` 下，
     被分类器当构建产物豁免，**根本走不到 confirm 档**。这正是 `CONTRIBUTING.md` 坑 3 记的坑，
     我读过那段还是踩了。改为从仓库根运行时拼路径（`recoverableTarget`）。

2. **两条旧断言不是"改绿"，是契约前提被推翻**
   `gates.test.js` 的两条 dsh 用例原本断言「`run('search_graph')` 之后 `read` 就放行」，
   `gate-policy.test.js` 断言 `dsh.config.graph_signal_requires_content === false`。
   三条都是把「dsh 看不到结果」写成断言。本 CHG 的结论是那个前提不成立，因此改的是断言本身，
   并在新用例里**额外断言旧行为必须是红的**（"calling the tool is not evidence"）。
   已在 SPEC §5 登记为超出初始清单的发现性问题。

3. **一件差点犯的错（记录在此以免复发）**
   实现中途我曾直接 `read` 了 `bridge/gates/dsh/index.js` 与 `pi/index.js` 全文，只在前置做了一次
   `get_architecture` + 一次 `search_graph`。这违反了本项目自己的 Layer 1 规则，被 Owner 当场指出。
   之后改为：先对要动的符号逐个点名（`search_graph` / `get_code_snippet` / `search_code`），
   再读文件。`policy.js` 全程**没有**直读全文，靠图谱拿到 8 个关键符号的签名与语义。

4. **图谱行号漂移**
   `get_code_snippet` 对 `SLACK_PATTERNS` 返回了错位内容（行号 3249–3257 实际是凭据扫描逻辑）。
   用 `search_code` 拿到真实行号 3430 后直读 60 行确认。**索引与源码不一致时以 `search_code` 的
   raw_matches 行号为准**，不要相信 snippet 的行段。

## E. 未验证点（如实声明）

| 项 | 状态 | 影响 | 缓解 |
|---|---|---|---|
| `agent.inject` / `agent.steer` 的 `UserMessage` 形状 | **未在真实 dsh 会话里验证**（单测用 fake agent） | 若形状被拒，提醒注入与轮次续跑不生效 | 适配层逐个尝试 3 种文档化形状，全失败时写 stderr 一行；**不抛**，不让轮次崩 |
| `session/event` 的 `assistant/message` 实际载荷 | 按「可见文本块」形状收集（只认 `text` / `text-delta`） | 若载荷形态不同，文本收集为空 → 轮次检查不判定 | 空文本直接跳过（宁可漏判不误伤） |
| `ctx.approval.effectivePolicy` 在移动端/CLI profile 的返回值 | 只按文档契约实现 | confirm 档可能退化为放行 | 退化为放行时**必写 stderr**，可被日志发现 |
| dsh 端 AI4S 产出物路径 | 接线级覆盖，无端到端用例 | 配置 `result_dirs` 后行为未经 dsh 侧验证 | 引擎侧已有独立用例；dsh 侧待真实 AI4S 会话验证 |

