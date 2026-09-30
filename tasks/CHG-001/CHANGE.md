# CHANGE-001 — 多 Agent 全局配置桥接器（用户可选、可撤回）

```yaml
change_id: CHG-001
title: 让用户按 agent 选择是否把 Claude Code 的全局配置作为其权威源；并支持随时撤回为原生配置
status: INTENT_ALIGNED
owner: user
created_at: 2026-09-27
evidence_date: 2026-09-27
```

## 1. 问题（Problem）

一台 Linux 开发机上同时安装了多个 AI 编码 agent（Claude Code、pi、Codex、Gemini CLI、Kimi Code）。它们的全局配置**分散在互不相通的目录约定里**：

| 资产 | Claude Code | pi | Codex | Gemini CLI | Kimi Code |
|---|---|---|---|---|---|
| skill | `~/.claude/skills/` | `~/.agents/skills/`（通用目录） | `~/.codex/skills/` | `~/.gemini/skills/` | `~/.agents/skills/` |
| 斜杠命令 | `~/.claude/commands/` | `~/.pi/agent/prompts/` | — | — | `~/.kimi-code/commands/` |
| 子 agent | `~/.claude/agents/` | — | — | — | — |
| 全局规则文档 | `~/CLAUDE.md` | `~/AGENTS.md` | `~/.codex/AGENTS.md` | `~/.gemini/GEMINI.md` | `~/.kimi-code/AGENTS.md` |
| MCP 声明 | `~/.claude.json` | `~/.pi/agent/mcp-adapter.json`（v3 起；旧 `mcp.json`） | `~/.codex/config.toml` | `~/.gemini/settings.json` | `~/.kimi-code/mcp.json` |
| 硬闸门/扩展 | `~/.claude/hooks/` | `~/.pi/agent/extensions/` | — | — | — |

**现状代价（本机实测）**：skill 源有 69 个目录形式 + 34 个平铺单文件（并存冗余）；`~/.codex/skills/` 只有 58 项、`~/.gemini/skills/` 只有 55 项，与 Claude 侧 106 项不一致；全局规则文档出现两套不同 md5 的分叉版本（`~/AGENTS.md` 与 `~/CLAUDE.md` 相同 = 31804 字节；`~/.codex/AGENTS.md` 与 `~/.gemini/GEMINI.md` 相同 = 28233 字节，**内容更旧**）；MCP 只登记在 Claude 与 Gemini 两端，Codex/pi 三端缺失或含明文密钥。

结论：**同一份能力在多端各存一份，靠人工复制维护，必然漂移。**

## 2. 期望结果（Outcome）

**由用户逐个 agent 选择**：把 Claude Code 的全局配置（技能 / 命令 / 子 agent / 规则文档 / MCP 声明）作为**该 agent 的权威源**，其余 agent 保持各自的原生配置不受影响。**并且这个选择随时可以撤回。**

成功表现为：

1. 默认状态下，本项目**不碰任何 agent 的全局配置**（全部 native）；
2. 用户显式 `adopt` 某个 agent 后，该 agent 的共享维度跟随 Claude Code；
3. 用户 `revoke` 某个 agent 后，该 agent 的全局配置**恢复成 adopt 之前的原生样子**；
4. 无论桥接与否，**各 agent 自身特有的配置（模型选择 / 主题 / 快捷键 / 权限 / 扩展 / 非 MCP 段）原样保留**；
5. 不执行的时刻不改动任何文件（无后台驻留、无定时任务、无文件监听）；
6. 全流程**零明文凭据入库**。

**根本动机**：主目录里已经堆了 `.claude` / `.codex` / `.gemini` / `.pi` / `.kimi-code` 等一串点目录——每来一家 CLI agent 或 AI IDE 就多一个。而**全局开发习惯、记忆（规则文档）、MCP 声明、skills** 本该只有一份。本项目把它们从"抄 N 遍"变成"选一个源 + 按需桥接 + 可撤回"。

## 3. 当前行为（Current Behavior）

* skill 的跨端复制靠一次性脚本（如 `sync-skill-pool.sh`、`deploy-skills.py`）手工执行，脚本与平台映射**硬编码在个人仓库**，且**不覆盖 pi / Kimi**；
* pi 之所以"也能用"skill，是因为某次初始化时做了符号链接 `~/.agents/skills -> ~/.claude/skills`（一次性、无版本、无回滚、无法审计、Windows 不可用）；
* MCP 配置靠人肉在 4 个格式各写一遍，密钥直接明文写在配置里；
* 规则主文档的"镜像一致性"靠人肉 `cp`，已经出现版本分叉；
* **没有任何机制能"只统一其中一个 agent"**，也没有任何机制能把某端恢复成原生配置。

## 4. 范围（Scope）

**做：**

* S1 定义"权威源 → 目标端"的**声明式映射**（含每端受管路径清单，清单外一律不碰）；
* S2 实现桥接器 CLI：`status` / `adopt` / `revoke` / `plan` / `apply` / `diff` / `doctor` / `rollback`；
* S3 **按 agent 选择与撤回的状态机**：`native（默认，不碰）` / `bridged（已 adopt）` / `revoked（已撤回，恢复原生）`；
* S4 **adopt 前自动快照**：为每个 agent 记录其被接管前的配置快照，使 `revoke` 能真正恢复原样；
* S5 MCP 配置**格式转换**：Claude 的 `mcpServers` JSON → Codex TOML、Gemini settings JSON、pi `mcp-adapter.json`、Kimi JSON；
* S6 **密钥外置**：仓库只存 `${VAR}` 占位符，真实值来自仓库外的 `secrets.env`，缺失即 fail-closed；
* S7 **保留私有配置**：桥接只覆盖共享维度，agent 自身特有配置（模型/主题/快捷键/权限/扩展等）原样保留；
* S8 幂等性、备份与回滚、`--dry-run` 优先的安全语义；
* S9 自检器：残留占位符、明文凭据模式（正则黑名单）、md5 漂移、快照完整性；
* S11 **声明式运行时依赖**：受管条目声明它需要的外部程序（`requires`），`doctor` 探测并在缺失时报告——针对「配置在盘上、内容正确、但没有任何程序读它」这类静默失效（ADR-004）；
* S12 **模型上下文窗口元数据治理**：为走网关的自定义 provider 建一张**有出处**的家族表，并由 `doctor` 比对机器上各份手抄副本（自定义 provider 扩展、`pi-router-catalog.json`），发现陈旧即报——**只报告，不重写**（ADR-005）；
* S10 **硬闸门（gate）**：把规则文档里最关键的规则抽成策略层（`bridge/gates/policy.js`），并给**有扩展机制的 harness** 铺上适配层（起步：pi、DeepSeek Harness），让规则从"建议"变成"工具级拒绝"；闸门走与其它内容同一套受管路径，因此 adopt 可快照、revoke 可卸载。

**非目标（Non-goals）：**

* ❌ **不替用户决定桥接哪些 agent**：默认全部 native，必须由用户显式 `adopt`；
* ❌ 不做插件市场 / 不抓取不安装第三方 skill（只搬运本机已有资产）；
* ❌ 不管理会话、历史、缓存等运行时数据（`~/.claude/projects/`、`~/.pi/agent/sessions/` 等）；
* ❌ 不做跨机器同步、不做云同步、不做守护进程、不做文件监听；
* ❌ 不改写各 agent 自身的代码或打补丁；
* ❌ 不代管各 agent 的专有扩展机制（Claude hooks / pi extensions）——只报告不接管。

## 5. 受影响模块（Affected Modules）

* 新建仓库 `agent-config-bridge`（`bridge/` CLI、`templates/`、`docs/ADR/`、`tests/`）；
* `bridge/lib/pi-models.js`（模型元数据表，仅当目标端是 pi 且本机装了 pi 时才被查询）；
* 本机 5 个 agent 的全局配置目录（只写受管清单内的文件）；
* 既有一次性脚本（`sync-skill-pool.sh` 等）——**不动**，本项目与其并存，待验证后由用户决定是否淘汰。

## 6. 约束（Constraints）

* C1 单机 Linux 优先，脚本需对 macOS 兼容（不依赖 GNU 专有参数），Windows 明确列为**非目标**（符号链接方案在 Windows 不可用，本项目用复制方案规避）；
* C2 零第三方依赖（仅 Node ≥ 20 标准库），避免新机器上先装依赖才能用；
* C3 不得引入后台服务、定时任务、shell rc 注入；
* C4 所有写盘操作先备份、可回滚；
* C5 仓库内**不得出现**：真实 IP / 域名 / 端口 / 用户名 / 绝对路径 / API key / 邮箱；
* C6 **默认不动作**：未 `adopt` 的 agent，任何命令都不得改动其任何文件；
* C7 **撤回必须真恢复**：`revoke` 必须基于 adopt 时的快照恢复，不得"尽力而为"。

## 7. 假设（Assumptions）

* A1 用户接受"Claude Code 是唯一权威源"这一前提（其他端只读不写）；
* A2 目标端目录已存在（由各 agent 自己创建）；不存在时桥接器**跳过并告警**，不擅自创建整套目录树；
* A3 用户本机已有 `~/.claude/skills` 等资产，无需本项目提供内容；
* A4 pi 与 Kimi 共用 `~/.agents/skills/`，两者天然共享一份 skill。

## 8. 风险（Risks）

| ID | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 覆盖用户在目标端的手改内容 | 高 | 受管清单 + 覆盖前备份 + `plan` 干跑 |
| R2 | 密钥随配置进入开源仓库 | 高 | 只存占位符 + 提交前正则黑名单自检（`doctor --strict`） |
| R3 | 各 agent 的配置格式随版本变化，转换逻辑失效 | 中 | 转换器按"能力"抽象，schema 断言 + 自检失败即报错不静默 |
| R4 | pi 的 skill 发现路径存在两种惯例（`~/.pi/agent/skills/` 与 `~/.agents/skills/`），旧版 pi 可能不认后者 | 中 | 默认写入 `~/.agents/skills/`（pi 文档明示支持且与 Kimi 共享），`doctor` 输出实际生效 skill 数供人工确认 |
| R5 | 删除语义误删他人资产 | 中 | 默认**只增不删**；删除必须显式 `--prune` 且同样先备份 |

## 9. 成功信号（Success Signals）

* SS1 默认（未 adopt）状态下，`plan` 输出"0 变更"，且任意命令的执行前后目标端文件 md5 完全不变；
* SS2 `adopt` → `apply` 后 `diff` 对所有受管文件报告 0 漂移；
* SS3 `revoke` 后，目标端文件与 adopt 前的快照逐字节一致；
* SS4 仓库全量正则扫描命中敏感模式 **0 次**；
* SS5 破坏性试验：删掉某个 bridged agent 的一个 skill 目录后 `apply`，能恢复且**其他 agent 的文件 md5 不变**；
* SS6 pi 侧 `/skill:<name>` 命令与权威源一一对应（抽样 5 个验证）；
* SS7 桥接后，被桥接 agent 的私有设置文件（如 pi `settings.json`）md5 不变。
* SS8 声明了 `requires` 的受管条目，在伴随程序缺失时 `doctor` **必然**报出（假阴性由负向用例锁死：移走包 → 报警，放回 → 消失）；
* SS9 家族表与 pi 发布数据的一致性由**读真实文件的测试**保证；本机普查 0 条陈旧（此项发现的 `shudie/kimi-k3` 已修）。

## 10. 未决问题（Unresolved Questions）

| ID | 问题 | 建议默认 | 需用户确认 |
|---|---|---|---|
| Q1 | 仓库名最终定名 | `agent-config-bridge`（已按用户决定） | ✅ 已定 |
| Q2 | 是否把 Claude 的 `agents/`（子 agent 定义）与 `output-styles/` 也纳入范围 | 纳入 `agents/`，**暂不**纳入 `output-styles/`（各端无对等概念） | ✅ |
| Q3 | codex / gemini / kimi 的 skill 是否需要**同时**保留平铺 `.md` 与目录形式 | 只保留目录形式（Agent Skills 规范推荐，且 pi 明确警告平铺形式） | ✅ |
| Q4 | 仓库是否包含一份"最小可运行示例"（fixture）以便在其他机器上验证 | 包含 `tests/fixtures/`，不含任何真实资产 | ✅ |
| Q5 | **默认桥接哪些 agent** | **一个都不桥接（全部 native）**，由用户逐个 `adopt` | ✅ 用户已明确 |
| Q6 | adopt 时若该 agent 已有内容与权威源冲突，如何处理 | 先快照，再以"权威源覆盖、冲突逐条列出"的方式同步；用户可在 `plan` 阶段中止 | 待确认 |
| Q7 | adopt 的快照保存在哪 | `<repo>/.bridge/snapshots/<agent>/<ts>/`（权限 700），仓库内但 `.gitignore` 排除 | ✅ 已定 |
| Q8 | **硬闸门（gate）怎么抽出来** | 策略层唯一（`bridge/gates/policy.js`）+ 每 harness 薄适配；优先 pi 与 DeepSeek Harness | ✅ 用户已明确 |

## 11. Evidence Pointers（取证位置）

* pi 官方文档：`docs/skills.md`（`~/.agents/skills/` 原生支持、目录形式优先）、`docs/configuration.md`（agent 目录各路径职责）、`docs/prompt-templates.md`（模板命令）；
* pi-mcp-adapter 源码 `config.ts` / `utils.ts`（已内置 claude-code 配置发现与 `${VAR}` 环境变量插值）；
* 本机探测：`.claude` 106 项 vs `.codex` 58 项 vs `.gemini` 55 项；规则文档两组不同 md5；
* 既有同类实现（作为对照与差异说明）：`sync-skill-pool.sh`、`deploy-skills.py`、`skill-deploy` skill。

## 12. 下一路由（Next Route）

`project-health-audit` → `prd` → `ai-spec`（本 CHG 已把 SPEC 骨架同时产出）。

## 13. 变更记录（Change Log）

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-09-29 | C1 平台约束修订：**Windows 原生纳入支持** | 技能链接改为 junction（免管理员权限），并为 `link` 规则增加自动创建与声明式校验（指向错误仍硬拒）；CI 增加 `windows-latest`。原 C1 中"Windows 明确列为非目标"作废；复制式桥接仍是各端默认，只有 manifest 显式声明的链接才走链接。 |
| 2026-09-29 | S10 硬闸门落地为三层 fallback（graph-first / index-before-read / index-freshness） | 由真实 Linux 参考实现移植，拦截文案与逐轮提醒为中文，并加入 Windows 路径归一化；同时识别 pi-mcp-adapter 代理模式下的图谱查询。 |
| 2026-09-29 | pi MCP 目标路径随 pi-mcp-adapter v3 改名 | 适配器 v3 起只读 `~/.pi/agent/mcp-adapter.json`（`mcp.json` 留给 pi 未来的内置 MCP）；manifest、测试与文档同步更新。 |
| 2026-09-29 | S11 声明式运行时依赖 + `doctor` 探测（ADR-004） | 受管条目可声明 `requires`（探针/备选位置/修复命令/后果）；`doctor` 在「已桥接且产物存在」时探测并报 `REQUIREMENT_MISSING`（warn）。planner 零改动。 |
| 2026-09-30 | S12 模型上下文窗口元数据治理（ADR-005） | 新增 `bridge/lib/pi-models.js`：按 model id 家族的表（**每条必须带 `source`**）+ 读 pi 发布数据的复验器 + `pi-router-catalog.json` 陈旧值检查。`doctor` 报 `PI_CATALOG_CONTEXT_STALE` / `PI_MODEL_TABLE_STALE`，**只报告不重写**。 |
