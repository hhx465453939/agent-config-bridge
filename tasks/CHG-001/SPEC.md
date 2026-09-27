# SPEC — 多 Agent 全局配置桥接器（用户可选、可撤回）

```yaml
change_id: CHG-001
version: 2                    # v1 假设"Claude 是全体 agent 的唯一源"，被用户否决；v2 引入 opt-in + revoke
status: draft                 # 用户批准后置 approved
prd_ref: PRD.md               # v2
health_ref: HEALTH.md
supersedes: null              # v1 未批准，不构成被取代的历史版本
adr_ref: [docs/ADR/001-bridge-architecture.md, docs/ADR/002-opt-in-and-revoke.md]
approved_by: null
approved_at: null
```

---

## 0. 阅读顺序

`CHANGE.md`（为什么做）→ `HEALTH.md`（现状债）→ `PRD.md`（产品契约）→ 本文件（工程契约）→ `TRACEABILITY.md`（追溯）→ `docs/plans/*.md`（分阶段施工图）。

---

## 1. 上下文、目标、非目标、约束、假设、未决问题

### 1.1 上下文

用户的诉求不是"把 Claude Code 一统天下"，而是**逐个 agent 选择**：哪些 agent 愿意让 Claude Code 当它的全局配置权威源、哪些要坚持自己独立写。并且这个选择**必须可撤回**——撤回后该 agent 要回到自己的原生配置，而不是留下残骸。同时，无论桥接与否，各 agent **自身特有的配置**（模型选择、主题、快捷键、权限、扩展、非 MCP 段）都不能被破坏。

### 1.2 目标（工程视角）

* E1 把"跨端派生"从人肉/一次性脚本，变成**可重复、可审计、可回滚、可撤回**的声明式桥接。
* E2 **默认零动作**：未显式选择的 agent，任何命令都不改动其文件。
* E3 撤回必须**真恢复**（基于 adopt 时的快照），不接受"尽力而为"。
* E4 桥接器零第三方依赖、可通读；`plan` 先于 `apply`。
* E5 全流程不产生任何敏感值入库。

### 1.3 非目标

同 PRD 第 4 节。工程侧额外明确：不做 daemon、不做 file watcher、不做增量哈希数据库（每次全量比对，规模 ≤ 数千文件，性能可接受）。

### 1.4 约束

| ID | 约束 | 来源 |
|---|---|---|
| C1 | Node ≥ 20，仅标准库；不得引入 npm 依赖 | PRD §7 |
| C2 | 目标端受管清单必须显式声明，禁止整目录镜像 | PRD §3 G5 |
| C3 | 任何写盘前必须先备份 | PRD §3 G6 |
| C4 | fail-fast：一步失败则中止，不继续写后续文件 | PRD §10 |
| C5 | 仓库内零真实敏感值（IP/域名/端口/用户名/绝对路径/凭据/邮箱） | PRD §3 G8 |
| C6 | 不创建目标端整套目录树，父目录不存在则跳过并告警 | PRD US-009 |
| C7 | Windows 原生不支持 | PRD §4 |
| C8 | **未 adopt 的 agent，任何命令都不得写入其任何文件** | PRD §3 G1 |
| C9 | **revoke 必须基于快照逐字节恢复；快照不完整则拒绝执行** | PRD §3 G3、R8 |
| C10 | 桥接只覆盖受管清单内的路径；私有配置文件永不出现在清单中 | PRD §3 G4 |

### 1.5 假设

* A1 各 agent 的目录由各工具自身创建，本项目只写入其**已存在**的父目录；
* A2 `~/.agents/skills/` 可被 pi 与 Kimi 同时发现（pi 官方文档明示；本机实测可见）；
* A3 用户接受"目标端受管文件的手改会被覆盖"，代价由备份、快照与回滚兜底；
* A4 主目录路径通过 `os.homedir()` 获得，仓库内代码不得硬编码任何绝对路径；
* A5 用户会在 adopt 前自行确认该 agent 上无"只存在于目标端、未在权威源"的关键资产（我们会告警，但无法判断重要性）。

### 1.6 未决问题（阻塞 SPEC 冻结的标 🔴）

| ID | 问题 | 建议 | 状态 |
|---|---|---|---|
| Q6 | adopt 时目标端已有内容与权威源冲突时的处理 | 先快照 → 覆盖受管清单内文件 → 冲突逐条列出 → plan 阶段可中止 | 🔴 待确认 |
| Q7 | 快照保存位置与保留策略 | `<home>/.local/state/agent-config-bridge/snapshots/<agent>/<ts>/`（权限 700）；保留最近 5 份 | 🔴 待确认 |
| Q8 | 是否提供 `--prune` | 提供，默认关闭 | 非阻塞 |
| Q9 | 上次同步时间戳位置 | `<home>/.config/agent-config-bridge/last-apply.json` | 非阻塞 |
| Q10 | 首次 adopt 的试点 agent | 由用户指定 | 🔴 待确认 |
| Q11 | pi / Kimi 的 skill 落点 | `~/.agents/skills/`（二者共享） | 🔴 待确认 |

---

## 2. 当前架构与被治理对象的债影响

* 现状实现：`sync-skill-pool.sh`（bash，硬编码三平台）、`deploy-skills.py`（Python，package 语义）、`~/.agents/skills` 软链。
* 债影响：本项目**不修改**上述既有资产（用户资产，可能他域在用），仅在 README 说明差异与并存关系；淘汰决策留给 `iteration-manager`。
* 新增债风险：桥接器成为"新的单点"——因此必须自带 `status` / `doctor` / `rollback` / `revoke`，且代码规模控制在可通读范围（目标 ≤ 1500 行 JS）。

---

## 3. 选定设计与 ADR / 权衡

详见 `docs/ADR/001-bridge-architecture.md` 与 `docs/ADR/002-opt-in-and-revoke.md`。此处给结论：

| 决策点 | 选定 | 被否方案 | 理由 |
|---|---|---|---|
| D1 同步机制 | **复制（copy）** | 符号链接 | 目标端可能整目录被工具重写；软链在 Windows 不可用；复制可逐文件比对与备份 |
| D2 配置来源 | **解析用户已有的 Claude 侧配置** | 让用户再维护一份中立配置 | 权威源必须是用户已经在用的那份，否则又回到双份维护 |
| D3 密钥处理 | **`${VAR}` 占位 + 仓库外 `secrets.env`** | 加密后入库 | 加密入库仍需分发密钥，且密钥泄漏等于明文 |
| D4 MCP 格式转换 | **能力抽象 + 每端写出器**（stdio / http 为最小公共集） | 通用 JSON→TOML 库 | 避免第三方依赖；只覆盖真实用到的字段 |
| D5 幂等实现 | **内容哈希比对** | mtime 比对 | mtime 不可靠（clone/checkout 会变） |
| D6 删除语义 | **默认只增不删**，`--prune` 显式开启 | 完全镜像 | 防止误删用户在目标端的自有资产（R9） |
| D7 skill 单一形态 | **只认目录形式 `SKILL.md`** | 同时搬运平铺 `.md` | Agent Skills 规范推荐；平铺与目录同名会产生发现歧义 |
| D8 目标端发现 | **写死受管清单 `bridge/targets/*.json`** | 运行时遍历 guess | 显式优于隐式；清单进版本控制可 review |
| **D9 接管粒度** | **按 agent opt-in，默认 native** | 一刀切全部接管 | 用户明确要求有选择（PRD §1） |
| **D10 撤回机制** | **adopt 时落完整快照；revoke 按快照反向恢复** | 只删本项目新增文件 | 只删新增文件无法还原"被覆盖的内容"，不叫撤回 |
| **D11 状态持久化** | **`state.json` 单一事实来源**（仓库外） | 散落在各 endpoint | 便于审计、便于撤销、便于 doctor 校验 |
| **D12 快照形态** | **文件级拷贝 + 清单（路径/模式/哈希）** | 打包 tar | 可逐项校验、可增量读取、失败可定位（体积可控） |

---

## 4. 接口、数据、安全、兼容、迁移、可观测、上线、回滚

### 4.1 CLI 接口

```
node bridge/cli.js <command> [options]

命令（按使用顺序）:
  status                    列出各 agent：是否存在、状态(native/bridged/revoked)、受管文件数、漂移数
  adopt <agent>...          选择让这些 agent 跟随 Claude Code（先快照，再首次同步）
  revoke <agent>...         撤回，按快照恢复该 agent 的原生配置
  plan                      输出变更计划（仅针对 bridged 的 agent），不写盘
  apply                     执行同步（覆盖前备份）
  diff                      仅报告漂移（仅针对 bridged 的 agent）
  doctor                    环境自检（状态/目录/权限/占位符残留/敏感模式/快照完整性）
  rollback [ts]             回退到指定或最近一次备份

options:
  --home <path>       覆盖主目录（测试用；默认 os.homedir()）
  --source <path>     覆盖权威源根（默认 <home>/.claude）
  --targets a,b       只处理指定目标端
  --prune             允许删除目标端多余的受管文件（默认关闭）
  --json              机器可读输出
  --strict            doctor/diff 出现警告也返回非 0
  --quiet, -q         精简输出
  --yes, -y           adopt/revoke 跳过交互确认（供脚本使用）
```

退出码：`0` 成功；`1` 业务失败（漂移/自检未过/快照不完整）；`2` 用法错误；`3` 环境错误（权限、源缺失）。

### 4.2 状态与快照数据契约

**单一状态文件**（仓库外）：

```jsonc
// <home>/.config/agent-config-bridge/state.json   (mode 600)
{
  "version": 1,
  "source": { "kind": "claude-code", "root": "<resolved at runtime>" },
  "agents": {
    "gemini": {
      "status": "bridged",              // native | bridged | revoked
      "adopted_at": "2026-09-27T10:15:00Z",
      "snapshot_id": "20260927T101500", // 指向 snapshots/<agent>/<id>/
      "managed_files": 42,              // 上次同步后的受管文件数
      "last_apply": "2026-09-27T10:20:00Z"
    },
    "kimi": { "status": "native", "adopted_at": null, "snapshot_id": null }
  },
  "format": "1"
}
```

* `status` 是唯一权威的开关：`native` 与 `revoked` 的 agent，`plan`/`apply`/`diff` 一律跳过并打印"未接管"；
* 状态文件缺失 → 全部视为 `native`（安全默认），并给出提示；
* 状态文件损坏 → **拒绝执行任何写操作**，提示修复或删除（删除即回到全 native）。

**快照目录**（仓库外，权限 700）：

```
<home>/.local/state/agent-config-bridge/snapshots/<agent>/<snapshot_id>/
  manifest.json          # 记录：被接管的路径清单、每条的动作(add/overwrite)、原文件 sha256、原文件权限
  files/                 # 原文件的逐字节拷贝（仅覆盖类动作才有）
```

* `manifest.json` 是 revoke 的唯一执行依据；
* revoke 前逐项校验 `sha256` 与文件存在性；任一缺失 → **拒绝执行**并给出精确路径（C9）；
* 每个 agent 保留最近 5 份快照，超出的从最旧开始清理（清理动作写日志）。

### 4.3 目标端清单（数据契约）

```jsonc
// bridge/targets/codex.json
{
  "name": "codex",
  "display": "OpenAI Codex",
  "detect": [".codex"],                    // 相对 $HOME 的存在性探测
  "home_hint": "~/.codex",                 // 仅用于展示
  "managed": [
    { "kind": "rules-doc", "from": "CLAUDE.md", "to": ".codex/AGENTS.md", "mode": "copy" },
    { "kind": "skill",     "from": "skills/*/SKILL.md", "to": ".codex/skills", "mode": "copy-tree" },
    { "kind": "mcp",       "from": "$claude-json#mcpServers", "to": ".codex/config.toml", "mode": "mcp-toml" }
  ],
  "never_touch": [                         // 显式声明"本端私有、永不接管"的路径
    ".codex/auth.json",
    ".codex/history.jsonl"
  ]
}
```

**每类 `kind` 的语义**

| kind | mode | 说明 |
|---|---|---|
| `rules-doc` | `copy` | 逐字节复制，产出目标端全局规则文档 |
| `skill` | `copy-tree` | 以目录为单位复制（含 scripts/references/assets） |
| `command` | `render` | 复制并做 frontmatter 适配 |
| `agent` | `copy` | 子 agent 定义 |
| `mcp` | `mcp-json` / `mcp-toml` | 由权威源 MCP 段转换生成 |

**清单必须显式枚举，`never_touch` 与 `managed` 不得重叠**（`doctor` 会校验并报错）。

### 4.4 MCP 转换契约

最小公共能力集（超出部分忽略并在报告中列出）：

| 字段 | stdio server | http server |
|---|---|---|
| `command` / `args` / `env` | ✅ | — |
| `url` / `headers` | — | ✅ |
| `${VAR}` 环境变量引用 | ✅ | ✅ |

写出目标：

| 目标 | 文件 | 形态 |
|---|---|---|
| pi | `~/.pi/agent/mcp.json` | `{"mcpServers": {...}}`；**保留** pi 私有字段（如 `directTools`） |
| Codex | `~/.codex/config.toml` | `[mcp_servers.<name>]` + `command`/`args`/`env` |
| Gemini | `~/.gemini/settings.json` | 与权威源同构的 `mcpServers`（**保留**该文件其它键） |
| Kimi | `~/.kimi-code/mcp.json` | 同构 JSON |

**合并语义（关键）**：桥接器只写"由权威源派生出的条目"，目标端原有且非派生来源的条目**保留**。实现方式是双向白名单：

1. 首次 adopt 时把目标端 MCP 段整体写入快照；
2. 之后的同步只覆盖"派生集合 ∩ 已登记集合"，新出现的用户自有条目不动；
3. 被移除的派生条目 → 从目标端删除（这是唯一允许的删除动作，且仅在 bridged 状态、且在白名单内）。

### 4.5 安全

| 项 | 措施 |
|---|---|
| 仓库脱敏 | 代码/文档/模板**只允许占位符**；`.gitignore` 拒绝 `*.env`、`secrets*`、`*.local.json` |
| 提交前扫描 | `scripts/scan-secrets.sh` 覆盖 8 类模式（IPv4、家目录绝对路径、邮箱、凭据赋值、长 token、私钥块、域名、主机别名），带窄豁免（loopback / 知名公开站点 / 占位符形态）；CI 与本地 pre-commit 双跑；`--history` 扫全史 blob |
| 运行时密钥 | `<home>/.config/agent-config-bridge/secrets.env`，权限 600，**不在仓库内**；缺失时对含 `${}` 的条目 fail-closed（报错退出，不写空值） |
| 产物权限 | 生成的目标配置（可能含展开后的密钥）写入后 `chmod 600` |
| 状态/快照权限 | `state.json` 600；快照目录 700 |
| 日志 | 输出中屏蔽任何形如 32+ 位 token 的字符串（`redact()` 统一处理） |
| 备份 | `<home>/.local/state/agent-config-bridge/backups/<ts>/`，权限 700 |

### 4.6 兼容

* 目标端结构随版本演进的应对：清单是唯一的"结构知识"所在地，结构变化只需改 JSON 不改代码；
* 每个写出器对目标文件做**结构断言**（写出后回读校验：JSON 可 parse、TOML 段落存在）；
* 目标端文件不存在 → 正常创建；**父目录不存在 → 跳过并告警**（C6）；
* 清单中声明了某端但该端未安装 → `status` 显示"未检测到"，`plan`/`apply` 跳过。

### 4.7 迁移

* 首次使用不迁移任何旧数据；adopt 行为本身即为"接管"，其前态被快照固化；
* 对既有的软链（如通用技能目录指向 Claude 技能目录）：`doctor` **检测并报告**；是否切换由用户决定。桥接器**不自动删除**软链，但会提示"当前处于软链模式，adopt 后可能出现同名冲突"。

### 4.8 可观测性

* `state.json` 记录每个 agent 的状态、adopt 时间、最后同步时间与受管文件数；
* 每次 `apply` 更新 `<home>/.config/agent-config-bridge/last-apply.json`（时间戳、目标端、文件计数、备份路径、失败项）；
* `--json` 输出供脚本消费；
* 日志级别：`-q` 仅摘要；默认每条变更一行；失败带源/目标路径与原因。

### 4.9 上线与回滚

* 上线：`status` → `adopt <试点 agent>` → `plan` → `apply` → `doctor --strict` → 抽样验证；
* 回滚（同步层）：`rollback`（无参回最近一次），回滚自身也先备份当前状态；
* 撤回（接管层）：`revoke <agent>`，按快照反向恢复，撤回前校验快照；
* 灾难兜底：所有被覆盖文件都留有副本（备份目录 + 快照目录），即使逻辑失效也可手工 `cp` 恢复。

---

## 5. 里程碑

> 每个里程碑 = 一次 implement → check → review 的闭环。依赖顺序不可跳过。

### M1 — 骨架、安全地基、状态层

| 项 | 内容 |
|---|---|
| 依赖 | 无 |
| 文件 | `bridge/cli.js`（命令分发/参数解析/退出码）、`bridge/lib/paths.js`、`bridge/lib/log.js`（含 `redact()`）、`bridge/lib/state.js`（state.json 读写/损坏检测）、`bridge/lib/plan.js`（计划数据结构）、`scripts/scan-secrets.sh`、`.gitignore`、`templates/secrets.env.example` |
| 交付 | `status` 在无状态文件时报告"全部 native"；`--help` 完整；扫描脚本可用 |
| 验收 | `node bridge/cli.js status` 退出 0；`node --test` 全绿；`bash scripts/scan-secrets.sh` 0 命中 |
| 检查 | `node --check` 全文件、`node --test`、扫描脚本 |
| 风险 | 状态损坏时行为不明确 → 单测覆盖"缺失/损坏/半损坏"三种 |
| 回滚 | 纯新增文件，`git revert` |

### M2 — adopt / revoke 状态机与快照

| 项 | 内容 |
|---|---|
| 依赖 | M1 |
| 文件 | `bridge/lib/snapshot.js`（快照落盘、manifest、校验、保留策略）、`bridge/lib/adopt.js`、`bridge/lib/revoke.js`、`tests/state.test.js`、`tests/snapshot.test.js` |
| 交付 | `adopt` 落快照并置 `bridged`（此阶段只改状态，尚未复制文件）；`revoke` 按快照恢复并置 `revoked`；快照缺失时拒绝执行 |
| 验收 | PRD US-002/003 的**状态与快照部分**验收通过；未 adopt 的 agent 文件 md5 不变 |
| 检查 | 单测（含"快照被删 → revoke 报错"）+ 真机演练 |
| 风险 | 快照不完整导致伪撤回（R8）→ manifest 逐文件 sha256 校验，缺一即拒 |
| 回滚 | `git revert` + 手工删除 `state.json` 回到全 native |

### M3 — 文件类桥接（skill / command / agent / rules-doc）

| 项 | 内容 |
|---|---|
| 依赖 | M2 |
| 文件 | `bridge/lib/scan-source.js`、`bridge/lib/manifest.js`、`bridge/lib/fs-ops.js`（复制/备份/权限）、`bridge/lib/render.js`（frontmatter 适配）、`bridge/targets/{pi,codex,gemini,kimi}.json` |
| 交付 | `plan`/`apply`/`diff` 对文件类资产全通；**仅对 bridged 的 agent 生效**；幂等；rollback 可用 |
| 验收 | PRD US-004/005/008 验收通过；native agent 零改动；bridged agent 私有文件零改动 |
| 检查 | 单测（fixture 目录树）+ 真机干跑 + 真机 apply 一次 |
| 风险 | 覆盖用户手改（R1）→ 备份 + plan 显式列出"将覆盖" |
| 回滚 | `rollback` + 备份目录 |

### M4 — MCP 跨格式派生 + 密钥外置 + 保留自有条目

| 项 | 内容 |
|---|---|
| 依赖 | M3 |
| 文件 | `bridge/lib/mcp/read-source.js`、`emit-pi.js`、`emit-codex-toml.js`、`emit-gemini.js`、`emit-kimi.js`、`bridge/lib/secrets.js`（`${VAR}` 展开 + fail-closed） |
| 交付 | 权威源 MCP 一次登记 → 各 bridged 端等价配置；含密钥条目走 secrets.env；产物 600；用户自有条目保留 |
| 验收 | PRD US-006 验收通过；fixture 往返单测；真机转换后人工核对一次；`--strict` 0 命中 |
| 检查 | 单测 + `doctor --strict` + 人工核对记录 |
| 风险 | 误删用户自有 MCP 条目（R9）→ 双向白名单 + 快照兜底；测用例必须含"用户自有条目保留"断言 |
| 回滚 | 备份 + 逐端 `--targets` 单独回退 |

### M5 — doctor 完整化 / rollback / 可观测

| 项 | 内容 |
|---|---|
| 依赖 | M4 |
| 文件 | `bridge/lib/doctor.js`（状态一致性、清单与 never_touch 冲突、目录权限、占位符残留、敏感模式、快照完整性、软链检测、陈旧度）、`bridge/lib/rollback.js` |
| 交付 | PRD US-007/008 验收通过；`doctor` 退出码语义正确（error/warn 分级） |
| 验收 | 人为制造漂移 → `doctor` 非 0；删除 bridged agent 的一个 skill → `apply` 恢复且其他 agent md5 不变 |
| 检查 | 单测 + 真实回放 |
| 风险 | 误报导致告警疲劳 → 分级并分别影响 `--strict` |
| 回滚 | `git revert` |

### M6 — 文档闭环、脱敏终检、真机端到端验收

| 项 | 内容 |
|---|---|
| 依赖 | M5 |
| 文件 | `README.md`、`docs/USAGE.md`、`docs/ADR/001-bridge-architecture.md`、`docs/ADR/002-opt-in-and-revoke.md`、`tasks/CHG-001/TRACEABILITY.md`（回填证据）、`CONTRIBUTING.md` |
| 交付 | 文档齐备；仓库脱敏终检 0 命中（含 `--history`）；真机端到端演练记录 |
| 验收 | PRD DoD 清单逐条勾选；`doctor --strict` 通过 |
| 检查 | 敏感扫描 + 文档走查 + 端到端演练 |
| 风险 | 文档过期（R6）→ DoD 要求文档与 PRD 一致并附演练记录 |
| 回滚 | 不涉及运行时 |

---

## 6. Definition of Ready / Definition of Done

**Ready（进入 M1 前）**

* [ ] PRD v2 状态 APPROVED，用户答复 Q6、Q7、Q10、Q11；
* [ ] 目标端路径表经用户确认；
* [ ] 仓库初始化（git init、LICENSE、.gitignore、CI workflow 骨架）；
* [ ] 试点 agent 由用户指定。

**Done（CHG-001 关闭）**

* [ ] M1~M6 全部验收通过并有证据（写入 TRACEABILITY 的 Evidence 列）；
* [ ] `status` 在干净状态下报告全 native；
* [ ] `adopt` → `apply` → `diff` = 0 漂移；`plan` 二次幂等（0 变更）；
* [ ] `revoke` 后与 adopt 前快照逐字节一致（有 md5 报告）；
* [ ] 未 adopt 的 agent 全程 md5 不变（有记录）；
* [ ] 被 adopt agent 的私有配置全程 md5 不变（有记录）；
* [ ] `doctor --strict` 通过；`rollback` 演练成功；
* [ ] 仓库敏感模式扫描 0 命中（含 `git log --all` 历史扫描）；
* [ ] README / USAGE / ADR×2 / PRD / SPEC 描述一致；
* [ ] pi 侧抽样 5 个 skill 的可见性验证记录（若 pi 被 adopt）；
* [ ] 未纳入项在 TRACEABILITY 标 `accepted`。

---

## 7. 评审与交付闸门（Review & Delivery Gates）

| 闸门 | 触发 | 通过条件 |
|---|---|---|
| G-review | 每个里程碑结束 | 自查四项（见下）+ 至少一个独立视角过一遍 diff |
| G-commit | 里程碑完成且自测通过 | 只 stage 本里程碑文件（禁止 `git add .`）；commit message 说明范围 |
| G-push | commit 完成 | 用户明示；`scan-secrets.sh` 0 命中；CI 绿 |
| G-release | 全部里程碑完成 | DoD 全勾；真机端到端记录归档 |

**自查四项（每个里程碑必答）**

1. 本里程碑改动是否只碰了受管清单内路径？是否确保了未 adopt agent 零改动？
2. 是否引入任何真实敏感值（IP/域名/端口/用户名/绝对路径/凭据/邮箱）？
3. 失败路径是否 fail-fast 且有可读报错？是否在快照不完整时拒绝执行？
4. 是否有可复现的验证命令（能写进 TRACEABILITY）？

---

## 8. 追溯与证据计划

见 `TRACEABILITY.md`。每行 = `PRD 需求 → SPEC 章节 → 里程碑 → 验证命令 → 证据落点`。

---

## 9. 授权边界（Authorization Boundaries）

| 动作 | 是否需要显式授权 |
|---|---|
| 写仓库文件 | 否（开发期默认） |
| **`adopt <agent>`**（改变某 agent 的接管状态、落快照、首次同步） | **是**（逐次，`--yes` 只用于已获授权的脚本场景） |
| **`revoke <agent>`**（恢复该 agent 原生配置） | **是**（逐次） |
| 在**本机**执行 `apply`（会改 bridged agent 的全局配置） | **是**（首次及每次改清单后） |
| 删除目标端多余受管文件（`--prune`） | **是**（逐次） |
| 清理过期快照（保留策略自动触发） | 否（但必须写日志） |
| 移除既有软链 | **是**（桥接器永不自动执行） |
| `git commit` | **是** |
| `git push` | **是** |
| 修改受管清单以外目录 | 禁止 |
