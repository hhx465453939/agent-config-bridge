# PRD — 多 Agent 全局配置桥接器（用户可选、可撤回）

```yaml
change_id: CHG-001
prd_version: 2                # v1 假设"Claude 是全部 agent 的唯一源"，已被用户否决；v2 改为 opt-in
status: DRAFT                 # 待用户批准；批准前不进入 SPEC 冻结
prd_ref: CHANGE.md
health_ref: HEALTH.md
created_at: 2026-09-27
amends: 无（v1 未批准，直接修订不另开版本）
approved_by: null
approved_at: null
```

---

## 1. 背景与问题

主目录里已经堆了一串点目录：`.claude`、`.codex`、`.gemini`、`.pi`、`.kimi-code`、`.cursor`……每来一家 LLM 供应商的 CLI agent 或 AI IDE，就多一个。

而下面这些本该**只有一份**的东西，被迫在每个点目录里各抄一遍：

* 全局开发习惯与记忆（规则主文档）
* MCP server 声明
* skills
* 斜杠命令 / 提示词模板

抄多了必然漂移。本机实测：Claude 侧可见 106 项 skill，Codex 只有 58 项，Gemini 只有 55 项；规则文档存在两组不同内容（31804 字节 vs 28233 字节）。

**但用户明确否决了"Claude 一刀切成所有 agent 的权威源"**：

> "pi、codex 必须要独立写……要有选择，就是让用户去挑选，到底要把 claudecode 的配置作为哪个 agent 的权威全局配置源，一定不能一刀切。"

因此本项目的问题定义修正为：

**如何让用户按 agent 自由选择"跟随 Claude Code"或"保持独立"，并且这个选择随时可以撤回，同时不破坏各 agent 自身特有的配置？**

## 2. 用户（Users）

| 角色 | 描述 | 核心诉求 |
|---|---|---|
| **主力用户** | 一台机器装 4~6 个 AI 编码 agent 的开发者；对其中**部分** agent 希望统一，对另一些坚持独立 | 按 agent 选择；能撤回；私有配置不被破坏 |
| 次级使用者 | 复用同一套约定的协作者 | 能读懂选择与撤回规则，安全复用 |

## 3. 目标（Goals）

* G1 **默认不动作**：初始状态所有 agent 均为 native，本项目不改动任何东西。
* G2 **按 agent 显式选择（opt-in）**：`adopt <agent>` 让指定 agent 的共享维度跟随 Claude Code。
* G3 **可撤回（revoke）**：`revoke <agent>` 把该 agent 的全局配置恢复为 adopt 之前的原生状态。
* G4 **只桥接共享维度**：skills / 命令 / 子 agent / 规则文档 / MCP 条目；agent 自身特有的配置原样保留。
* G5 **不误伤**：受管清单之外的文件字节不动；未 adopt 的 agent 完全不动。
* G6 **可回滚**：任何一次同步能退回上一状态。
* G7 **可移植**：新机器 clone + 填 `secrets.env` + `status` → `adopt` → `apply` 即可。
* G8 **零泄露**：仓库任何 commit 不含真实凭据 / IP / 域名 / 端口 / 用户名 / 绝对路径 / 邮箱。

## 4. 非目标（Non-goals）

* ❌ **不替用户决定桥接谁**：默认全部 native，必须显式 `adopt`。
* ❌ 不做插件市场 / 不抓取不安装第三方 skill。
* ❌ 不管理会话、历史、缓存、凭据文件。
* ❌ 不做跨机实时同步、不做云同步、不做守护进程、不做文件监听。
* ❌ 不代管各 agent 的专有扩展机制（Claude hooks / pi extensions）。
* ❌ 不做 skill 内容质量评审（那是 skill-audit / code-review 的职责）。
* ❌ 不支持 Windows 原生。

## 5. 用户故事（User Stories）

```yaml
- id: US-001
  title: 看清这台机器上各 agent 的状态
  user: 主力用户
  outcome: 一条 status 就知道哪些 agent 存在、各自是 native / bridged / revoked、各自漂移多少
  priority: 1
  dependencies: []
  acceptance_criteria:
    - 输出包含每个被探测到的 agent 的名称、状态、受管文件数、漂移数
    - 未安装的 agent 显示为"未检测到"而非报错
    - status 不写盘
  evidence_method: [单元测试, 真机执行并人工核对]
  risks: [探测规则写死导致新增 agent 无法识别]

- id: US-002
  title: 选择让某个 agent 跟随 Claude Code
  user: 主力用户
  outcome: adopt 之后，该 agent 的共享维度与 Claude Code 一致，而其私有配置分毫未动
  priority: 1
  dependencies: [US-001]
  acceptance_criteria:
    - adopt 前自动对该 agent 落一份完整快照（用于 revoke）
    - adopt 只对指定 agent 生效，其他 agent 文件 md5 完全不变
    - adopt 后该 agent 的私有配置文件（如 pi settings.json）md5 不变
    - 冲突项（目标端已有、内容不同）在输出中逐条列出，不静默覆盖
  evidence_method: [单元测试, 真机 adopt 一次 + md5 全量比对]
  risks: [误伤私有配置, 快照不完整导致 revoke 失败]

- id: US-003
  title: 撤回，恢复该 agent 的原生配置
  user: 主力用户
  outcome: revoke 之后，该 agent 回到 adopt 之前的样子，仿佛本项目从未介入
  priority: 1
  dependencies: [US-002]
  acceptance_criteria:
    - revoke 后目标端文件与 adopt 时的快照逐字节一致
    - 被 adopt 时新增的文件被移除；被覆盖的文件被还原
    - 未 adopt 的 agent 不受影响
    - revoke 本身也先备份当前状态（可二次撤销）
  evidence_method: [单元测试（快照往返）, 真机演练一次]
  risks: [快照缺失时误导用户以为已还原]

- id: US-004
  title: 干跑审阅桥接计划
  user: 主力用户
  outcome: 在真正写盘前看到"将新增/更新/跳过/删除"的完整文件级清单
  priority: 1
  dependencies: [US-001]
  acceptance_criteria:
    - plan 输出每条变更的类型、源路径、目标路径
    - plan 不产生任何写入（mtime 快照校验）
    - 同一状态重复执行 plan，输出稳定（可 diff 为空）
    - 只列出 bridged 状态的 agent，native 的显示为"未接管，跳过"
  evidence_method: [单元测试, 真机干跑 + mtime 快照]
  risks: [计划与实际执行不一致]

- id: US-005
  title: 一键同步
  user: 主力用户
  outcome: apply 后所有 bridged agent 的受管文件与权威源逐字节一致
  priority: 1
  dependencies: [US-004]
  acceptance_criteria:
    - apply 后 diff 报告 0 漂移
    - 每个被覆盖的文件都在备份目录留有原始副本
    - 重复执行 apply 幂等（第二次 plan 为 0 变更）
    - native / revoked 状态的 agent 一个文件也不动
  evidence_method: [单元测试, 真机执行 + md5 比对]
  risks: [覆盖用户手改内容]

- id: US-006
  title: MCP 配置跨格式派生且密钥不落仓
  user: 主力用户
  outcome: Claude 侧登记一次 MCP server，被 bridge 的 end 自动获得等价配置，仓库内无明文凭据
  priority: 1
  dependencies: [US-005]
  acceptance_criteria:
    - Claude JSON → Codex TOML / Gemini JSON / pi JSON 结构等价
    - 源配置允许写 ${VAR}，同步时用仓库外 secrets.env 展开
    - 被引用但未提供的变量 → fail-closed 报错，不写空值
    - 生成的目标文件权限 600
    - 目标端原有且非本项目来源的 MCP 条目保留
  evidence_method: [fixture 往返单测, 真机转换后核对, 敏感扫描]
  risks: [格式转换错误导致 agent 启动失败, 密钥泄漏, 误删用户自有 MCP 条目]

- id: US-007
  title: 环境自检与漂移报告
  user: 主力用户
  outcome: 一条 doctor 回答"哪些 bridged agent 漂移了 / 有无裸占位符 / 有无疑似密钥 / 快照是否完整"
  priority: 2
  dependencies: [US-005]
  acceptance_criteria:
    - 输出各 agent 状态、受管文件数、漂移数、占位符残留数、敏感命中数、快照完整性
    - 发现漂移或命中时退出码非 0（不静默通过）
    - error 与 warn 分级，--strict 时 warn 也导致非 0
  evidence_method: [单元测试, 人为制造漂移后的回放]
  risks: [误报噪音使告警失效]

- id: US-008
  title: 回滚到指定备份
  user: 主力用户
  outcome: 同步出错后能精确退回某一次同步之前
  priority: 2
  dependencies: [US-005]
  acceptance_criteria:
    - rollback 无参回最近一次；带时间戳回指定一次
    - 回滚前再次备份当前状态
    - 回滚后目标文件与备份逐字节一致
  evidence_method: [单元测试, 真机演练]
  risks: [误回滚到更旧状态]

- id: US-009
  title: 新机器上机
  user: 主力用户（换机/新机）
  outcome: clone → 填 secrets.env → status → adopt → apply，获得与旧机一致的被选 agent 配置
  priority: 3
  dependencies: [US-002, US-006]
  acceptance_criteria:
    - README / docs/USAGE.md 的步骤在干净环境可照抄执行成功
    - 缺少 secrets.env 时给出明确提示而非崩溃或静默生成空配置
    - 目标端目录不存在时跳过并告警，不擅自创建整套目录树
  evidence_method: [文档走查, 干净用户目录模拟执行]
  risks: [文档过期]

- id: US-010
  title: 把规则文档里最关键的那几条落成硬闸门
  user: 主力用户
  outcome: 对**有扩展机制的** agent（pi、DeepSeek Harness），"读源码前先查代码图谱"这类规则不再只靠模型自觉 —— 跳过就被工具拒绝；且这套能力随 adopt/revoke 自然获得与卸载
  priority: 1
  dependencies: [US-002, US-003]
  acceptance_criteria:
    - 规则逻辑只存一处（策略层），每个 harness 的适配层是薄的翻译层，不重复实现规则
    - adopt 装上闸门；revoke 按快照连闸门目录一起恢复，且不碰同父目录里用户自己的扩展
    - 闸门安装幂等（第二次 plan 对闸门文件报 0 变更）；手改 policy 能被 diff 捕获并可被 apply 修复
    - 策略文件缺失/损坏时 **fail open 并告警**，绝不把 agent 卡死；每会话拦截次数有上限
    - harness 不自动加载扩展时（dsh）必须如实说明"已安装但需手动挂载"，并给出那行配置
    - 没有扩展机制的 harness（Kimi）在 status 里明说"规则仍是建议"，不装作已覆盖
    - 不在任何地方硬编码作者本人的家目录/项目路径（作用范围靠配置或向上找 VCS 根）
  evidence_method: [策略层纯逻辑单测, 假 harness 对象驱动适配层, 沙箱内整树快照对比]
  risks: [适配器写错会让闸门静默失效, 装进去但未挂载给人假安全感, 规则写死把人卡住]
```

## 6. 范围

| 项 | 纳入 | 说明 |
|---|---|---|
| 选择 / 撤回机制 | ✅ | 核心；`adopt` / `revoke` / `status` 与快照 |
| skills | ✅ | 目录形式（`SKILL.md`）；平铺 `.md` 判定为冗余不搬运 |
| commands / prompts | ✅ | 各端格式适配 |
| agents（子 agent） | ✅ | 目标端支持时桥接，不支持则报告跳过 |
| 全局规则文档 | ✅ | 由权威源派生各端镜像名 |
| MCP 声明 | ✅ | 跨格式转换 + 密钥外置 + 保留用户自有条目 |
| **硬闸门（gate）** | ✅ | 仅对有扩展机制的 harness（pi、dsh）；Kimi 无此机制，明确报告不覆盖 |
| **各端私有设置** | ❌ 保留 | 模型/主题/快捷键/权限/非 MCP 段 |
| **各端扩展机制** | ❌ | Claude hooks、pi extensions：只报告不代管 |
| output-styles / themes | ❌ | 无对等概念 |
| 会话 / 历史 / 缓存 / 凭据文件 | ❌ | 运行时数据 |

## 7. 依赖

| 依赖 | 说明 | 阻塞? |
|---|---|---|
| Node ≥ 20 | 运行桥接器 | 是（硬依赖） |
| 各 agent 自身已安装并已生成全局目录 | 目标端存在性 | 否（缺失则跳过告警） |
| `secrets.env`（仓库外） | 提供 MCP 密钥等真实值 | 仅含密钥的 MCP 条目需要 |

## 8. 风险与缓解

沿用 `CHANGE.md` 第 8 节 R1~R5，PRD 层面补充：

| ID | 风险 | 缓解 |
|---|---|---|
| R6 | 用户误以为"全自动、以后不用管"，实际仍需在改完 Claude 侧后跑一次 apply | README 顶部与 USAGE 显著说明触发时机；doctor 输出"上次同步时间" |
| R7 | 过度泛化到所有 agent，维护成本反超收益 | 首版只支持已验证目标端；新增端走 amendment |
| R8 | **revoke 快照损坏/缺失，用户以为已还原实际没有** | revoke 前校验快照完整性；缺失时明确报错并拒绝执行，不做"尽力而为"的恢复 |
| R9 | adopt 时把用户在该 agent 上的自有积累（如它独有的 skill）覆盖掉 | adopt 前快照 + 冲突逐条列出 + plan 可中止；`--prune` 默认关闭 |

## 9. 成功度量（Success Metrics）

| 指标 | 目标值 | 测量方式 |
|---|---|---|
| 默认（全 native）下 `plan` 变更数 | 0 | 集成测试 |
| 未 adopt 的 agent 被改动次数 | 0（任何命令） | md5 快照对比 |
| adopt 后跨端漂移文件数 | 0 | `diff` |
| revoke 后与 adopt 前快照差异 | 0 | md5 全量比对 |
| 幂等性 | 连续两次 apply 后 plan = 0 变更 | 集成测试 |
| 私有配置被改动次数 | 0 | pi settings.json 等 md5 对比 |
| 仓库敏感模式命中 | 0 | `scripts/scan-secrets.sh`（CI 内） |
| 新增一个 skill 到被 bridge 的 agent 可用所需人工操作 | ≤ 2 步 | 人工演练 |

## 10. 部署与运行期望（Rollout）

* 首版在用户本机试用（先 adopt 一个非关键 agent 验证，再扩到其他）；
* 不涉及线上服务、无灰度概念；
* 失败行为：任何一步出错即**中止且不继续写后续文件**（fail-fast），已写文件保留备份可回滚。

## 11. 定义就绪 / 定义完成

**Definition of Ready（开工前置）**

* [ ] `CHANGE.md` 的 Q6、Q7 已获用户答复；
* [ ] 本 PRD（v2）获用户批准；
* [ ] 目标端路径表经用户确认（尤其 pi / Kimi 的 skill 落点选择）；
* [ ] 首次 adopt 的**试点 agent** 由用户指定（建议选一个非关键端）。

**Definition of Done（产品完成）**

* [ ] US-001~US-008、US-010 验收标准全部有证据；US-009 有文档走查记录；
* [ ] 真机演练：`status` → `adopt <试点>` → `plan` → `apply` → `diff`(0) → `revoke` → 快照比对(0)；
* [ ] 未 adopt 的 agent 全程 md5 不变（有记录）；
* [ ] 被 adopt agent 的私有配置全程 md5 不变（有记录）；
* [ ] `rollback` 真机演练一次成功；
* [ ] 仓库脱敏扫描 0 命中（含 `--history`）；
* [ ] README / USAGE / ADR / PRD / SPEC 五处描述一致；
* [ ] 遗留项在 TRACEABILITY 中显式记录为 accepted。

## 12. 验收矩阵

| 故事 | 验收方式 | 证据产物 |
|---|---|---|
| US-001 | 真机执行 + 单测 | status 输出 + 人工核对记录 |
| US-002 | adopt 前后 md5 全量比对 | 比对报告、快照目录清单 |
| US-003 | 快照往返单测 + 真机演练 | revoke 前后 md5 报告 |
| US-004 | 干跑 mtime 快照 | plan 快照 diff |
| US-005 | 全量 md5 比对 + 幂等复跑 | diff 报告（0 漂移） |
| US-006 | fixture 往返单测 + 敏感扫描 | 单测输出 + 扫描报告 |
| US-007 | 制造漂移后回放 | doctor 输出（非 0 退出码） |
| US-008 | 回滚前后 md5 比对 | 演练记录 |
| US-009 | 文档走查 / 干净环境模拟 | 走查清单 |
| US-010 | 策略层单测 + 适配层假 harness 驱动 + 沙箱整树快照 | `node --test` 输出 |

## 13. 未决问题

| ID | 问题 | 建议默认 |
|---|---|---|
| Q6 | adopt 时目标端已有内容与权威源冲突，如何处理 | 先快照；以权威源覆盖**受管清单内**的文件；冲突逐条列出；plan 阶段可中止 |
| Q7 | adopt 快照保存位置与保留策略 | `<repo>/.bridge/snapshots/<agent>/<ts>/`（权限 700）；保留最近 5 份 |
| Q8 | 首版是否要 `--prune` | 提供该 flag，默认关闭 |
| Q9 | 是否需要把同步时间戳落盘 | 是，`<repo>/.bridge/last-apply.json` |
| Q10 | 试点 agent 选谁 | 由用户指定；建议先用一个"毁掉也不心疼"的端验证 |

## 14. 下一路由

用户批准本 PRD（v2）后 → `SPEC.md`（v2）定稿 → 批准 → `goal-driven-development` 实施。
