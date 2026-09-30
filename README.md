# agent-config-bridge

**由你决定，哪个 agent 跟随 Claude Code。**

很多开发者的主目录已经变成了"点目录动物园"：

```
~/.claude  ~/.codex  ~/.gemini  ~/.pi  ~/.kimi-code  ~/.cursor  ~/.codebuddy ...
```

每装一个 CLI agent 或 AI IDE，就多一个 `.xxx` 目录；而**全局开发习惯、记忆（规则文档）、MCP 声明、skills** 这些本该只有一份的东西，被迫在每个目录里各抄一遍。抄多了必然漂移：这个 agent 会用的技能，那个 agent 不会用；今天改过的规则，明天某端还是旧的。

这个项目给一个**可逆的选择**：把你指定的 agent 的全局配置，**适配性地桥接到 Claude Code**，让 Claude Code 成为它的权威源。**选哪些 agent、要不要撤，全由你决定**；没被选中的 agent 一律不碰。

---

## 核心：这是一个"选择 + 可撤回"的工具

| 能力 | 说明 |
|---|---|
| **按 agent 选择（opt-in）** | 默认**所有 agent 都是 native（原生配置）**，本项目不碰。你显式 `adopt` 哪个，才桥接哪个。想保留 pi、Codex 自己独立写配置？那就别 adopt 它们。 |
| **随时撤回（revoke）** | `revoke <agent>` 把该 agent 的全局配置**恢复成它自己的原生配置**——即 adopt 那一刻之前的样子。撤回后该 agent 回到独立状态。 |
| **保留 agent 自身特有配置** | 桥接的是"共享维度"（skills / 命令 / 规则文档 / MCP 条目）。该 agent 的私有设置（模型选择、主题、快捷键、权限、扩展、非 MCP 段配置）**原样保留**，不会被覆盖。 |
| **只增不删** | 默认不删除任何多余文件；删除需显式 `--prune`。 |
| **干跑优先** | `plan` 先给你看"将改哪些文件"，确认后再 `apply`。 |
| **可回滚** | 每次同步前备份；`rollback` 一键退回。 |

### 三种状态

```
native    ← 默认。完全不碰该 agent 的全局配置
bridged   ← 你 adopt 过的。受管维度跟随 Claude Code
revoked   ← 曾桥接、已撤回。恢复原生配置，保留一条记录
```

```
        ┌─────────────────────────┐
        │   ~/.claude （权威源）    │   只有被 adopt 的 agent 才会读它
        └───────────┬─────────────┘
                    │
      adopt pi ─────┤                    codex / gemini 未 adopt
                    │                    → 保持各自的原生配置，本项目不碰
                    ▼
             ~/.agents/skills/  （pi 共享技能目录）
             ~/.pi/agent/prompts/ 、MCP 条目
             ▲
             └── 保留 ~/.pi/agent/settings.json、extensions/ 等私有部分
```

## 给谁用

* 一台机器上装了好几个 AI 编码 agent，被"同一份 skill 抄四遍"折磨的开发者；
* 只想让**部分** agent 统一（比如 Gemini CLI 和 Kimi 跟随 Claude Code），同时坚持另外几个（比如 pi、Codex）自己独立写；
* 试过符号链接方案，但发现它不可审计、不可回滚、Windows 还不好使的人。

## 快速开始

```bash
git clone <仓库地址> ~/Development/agent-config-bridge
cd ~/Development/agent-config-bridge

# 0. 看看这台机器上有哪些 agent，各自什么状态
node bridge/cli.js status

# 1. 选择要让哪些 agent 跟随 Claude Code（可一次多个）
node bridge/cli.js adopt gemini kimi

# 2. 看会改什么，不落盘
node bridge/cli.js plan

# 3. 真的同步
node bridge/cli.js apply

# 4. 哪天不想让某个 agent 跟随了，撤回成它自己的原生配置
node bridge/cli.js revoke kimi
```

> 第 1 步的 `adopt` 会**先给该 agent 的现有配置拍一张快照**，`revoke` 就是靠它恢复。所以"撤回"是真的能退回原样，不是尽力而为。

命令一览：

| 命令 | 作用 |
|---|---|
| `status` | 列出各 agent 的当前状态（native / bridged / revoked），以及漂移数 |
| `adopt <agent>...` | 选定若干个 agent，让 Claude Code 成为它们的权威源（先快照，再首次同步） |
| `revoke <agent>...` | 撤回，恢复该 agent 的原生配置 |
| `plan` | 打印完整变更计划（新增/更新/跳过），**不写盘** |
| `apply` | 执行同步；只对 bridged 状态的 agent 生效；覆盖前先备份 |
| `diff` | 只报告漂移，不写盘 |
| `doctor` | 环境自检：目录、权限、占位符残留、敏感模式、快照完整性、**运行时依赖是否还在**（见下） |
| `rollback [时间戳]` | 退回最近一次（或指定一次）同步之前 |

## 会桥接什么、不会碰什么

| 维度 | 是否桥接 | 说明 |
|---|---|---|
| skills | ✅ | 目录形式的技能（`SKILL.md` 规范），逐文件比对复制 |
| 斜杠命令 / 提示词模板 | ✅ | 各端文件格式做适配 |
| 子 agent 定义 | ✅ | 目标端支持时桥接，不支持则报告跳过 |
| 全局规则文档（开发习惯 / 记忆） | ✅ | 由权威源派生出各端镜像名 |
| MCP server 声明 | ✅ | 做跨格式转换；密钥走仓库外的 `secrets.env` |
| **硬闸门（gate）** | ✅ | 仅对有扩展机制的 agent（见下节） |
| **各端私有设置** | ❌ | 模型选择、主题、快捷键、权限白名单、非 MCP 段配置 —— 原样保留 |
| **模型上下文窗口元数据** | ❌ 只报告 | 自定义 provider 扩展与 `pi-router-catalog.json` 里各存一份 `contextWindow`，且目录那份**永不自动刷新**；`doctor` 比对后报警，**不重写**（见 `docs/ADR/005`、`docs/USAGE.md` §5.9） |
| **各端扩展 / 插件** | ❌ | 你自己写的扩展原样保留；本工具只往里面加**它自己那一个子目录** |
| 会话 / 历史 / 缓存 / 凭据文件 | ❌ | 运行时数据，永不触碰 |
| output-styles / themes | ❌ | 无对等概念 |

完整的受管路径清单见 `bridge/targets/*.json` —— **清单是唯一的结构知识来源**，代码里没有"猜路径"的逻辑。清单里没有的东西，本项目一律不碰。

## 硬闸门：让规则文档真的被遵守

规则文档是**建议**。你会读它、通常会照做 —— 但"通常会"不够。有些规则的收益只有在**真的执行**时才成立，例如「读源码之前先查代码图谱」：一旦跳过，图谱就用不上了。

Claude Code 的产品结构比较完整，这类约束能靠它自己的机制兜住；**pi、DeepSeek Harness 这类较新的 harness 没有那么多内建结构**，所以这条能力在这里价值更高。本项目把规则文档里最关键的那几条落成**工具级拒绝**：模型想绕也绕不过去。

### 做法：规则逻辑唯一，harness 适配层很薄

```
bridge/gates/
  policy.js        规则本身（纯逻辑，不知道自己在哪个 harness 里跑）
  pi/              pi 的适配层：pi.on('tool_call') → policy → { block, reason }
  dsh/             dsh 的适配层：ctx.on('tools/pre-execute') → policy → { kind: 'deny' }
```

换个 harness 只需要再写一个几十行的翻译层，规则本身不用动。也不会出现"pi 管、dsh 不管"这类静默不一致。

### 目前支持情况

| Agent | 硬闸门 | 说明 |
|---|---|---|
| **pi** | ✅ 自动生效 | pi 会自动加载扩展目录，装上即生效 |
| **DeepSeek Harness** | ✅ 装上 + **需手动挂载一行** | dsh 不自动加载扩展目录，插件要被组合显式挂载；`status` 会明说"已安装但未挂载"，并给出那行配置 |
| Kimi Code | ❌ | 它没有用户可装的扩展/钩子机制，规则对它仍只是建议（`status` 里明说，不装作支持） |

### 内置的检查项（可配置）

| 检查项 | 作用 | 默认 |
|---|---|---|
| `graph-before-read` | 读源码前必须先成功查过一次代码图谱 | ✅ |
| `index-before-read` | 仓库还没建索引时，先建索引 | 可选 |
| `no-write-outside` | 限制写入范围（需配置允许的根目录） | 可选 |
| `no-secret-write` | 写入内容里出现真凭据时拦截 | 可选 |

策略文件是普通 JSON（`<扩展目录>/policy.json`），你可以直接改：改检查项、改作用范围、改"一个会话最多拦几次"。

### 安全默认

* **策略文件读不出来 → 放行**（fail open）并告警。一条写错的规则把 agent 卡死，比某条规则暂时没执行严重得多。
* **每个会话最多拦 3 次**，之后放行 —— 万一规则写错，最多浪费几次往返。
* 用不着"我的项目在某个固定目录"这种硬编码：作用范围按"配置优先，否则沿目录向上找 `.git`"判定。
* 闸门文件走和其它内容**完全一样的受管路径**：`adopt` 时被快照，`revoke` 时被卸载，只动它自己那个目录，你写的其它扩展原样保留。

## 敏感信息处理

桥接的 MCP 配置里常有 API key、邮箱、内网地址。本项目采用**模板化 + 环境变量**：

* 仓库内**只存占位符**（如 `${你的变量名}`），永不存真实值；
* 真实值放本机 `~/.config/agent-config-bridge/secrets.env`（权限 `600`，**不在本仓库内**）；
* 同步时做变量展开，含真实值的产物写入后自动 `chmod 600`；
* 被引用但未提供的变量 → **直接报错退出**（fail-closed），不会写入空值把配置弄坏。

```bash
mkdir -p ~/.config/agent-config-bridge
cp templates/secrets.env.example ~/.config/agent-config-bridge/secrets.env
chmod 600 ~/.config/agent-config-bridge/secrets.env
$EDITOR ~/.config/agent-config-bridge/secrets.env
```

> 贡献代码前请先读 `CONTRIBUTING.md` 的脱敏铁律：真实 IP / 域名 / 端口 / 用户名 / 绝对路径 / 凭据 / 邮箱一律不得进入仓库。

## 边界（不做什么）

* **不做插件市场**：不抓取、不安装第三方 skill，只搬运你本机已有的。
* **不做运行时数据同步**：会话、历史、缓存、凭据不在范围内。
* **不做跨机器实时同步**：这是单机工具；换机器时在目标机器上跑同一份 `apply`。
* **不改别人的模型元数据**：pi 的 `pi-router-catalog.json` 与自定义 provider 扩展都是**它们自己的状态**（一个由插件持续写入，一个是用户写的程序）。`doctor` 发现与 pi 发布数据不一致时只报 `PI_CATALOG_CONTEXT_STALE`，并指出"它不会自己刷新"——修正动作留给你。理由见 `docs/ADR/005`。
* **不替你做决定**：默认不 adopt 任何 agent；要不要桥接、撤回，都由你显式发起。
* **平台**：Linux / macOS / Windows 原生均支持。Windows 上的技能链接用 **junction**（无需管理员权限，由工具自己创建），其余受管内容在所有平台走同一套复制 + 哈希比对；CI 在三个平台跑同一套测试。

## 与符号链接方案的区别

手工把通用技能目录软链到 Claude 的技能目录，确实能"少抄一遍"，但：无法逐文件审计（说不清哪几个文件漂移了）、无法回滚、还可能被目标端工具整目录重写后静默失效。

本工具默认用**复制 + 逐文件哈希比对**，换来可审计（`diff`）、可回滚（`rollback`）、可撤回（`revoke`）——代价是 Claude 侧改动需要跑一次 `apply` 才生效（本项目不常驻、不监听）。唯一的例外是 pi 的 `~/.agents/skills`：它是一条**声明式链接**（manifest 里显式声明、`doctor` 会校验指向），由工具在 adopt 时自动创建（POSIX 符号链接 / Windows junction）、被快照、可撤回——不是一条没人管的软链。

## 目录结构

```
bridge/         桥接器本体（Node 20+，零第三方依赖）
templates/      环境变量与目标端配置模板
docs/           架构决策记录（ADR）与使用手册
bridge/test/    单元测试与 fixture（node --test，无框架依赖）
tasks/          按变更编号归档的 CHANGE / HEALTH / PRD / SPEC / TRACEABILITY
```

## 许可

MIT，见 `LICENSE`。
