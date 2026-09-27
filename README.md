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
| `doctor` | 环境自检：目录、权限、占位符残留、敏感模式、快照完整性 |
| `rollback [时间戳]` | 退回最近一次（或指定一次）同步之前 |

## 会桥接什么、不会碰什么

| 维度 | 是否桥接 | 说明 |
|---|---|---|
| skills | ✅ | 目录形式的技能（`SKILL.md` 规范），逐文件比对复制 |
| 斜杠命令 / 提示词模板 | ✅ | 各端文件格式做适配 |
| 子 agent 定义 | ✅ | 目标端支持时桥接，不支持则报告跳过 |
| 全局规则文档（开发习惯 / 记忆） | ✅ | 由 Claude 侧规则主文档派生出各端镜像名 |
| MCP server 声明 | ✅ | 做跨格式转换；密钥走仓库外的 `secrets.env` |
| **各端私有设置** | ❌ | 模型选择、主题、快捷键、权限白名单、非 MCP 段配置 —— 原样保留 |
| **各端扩展 / 插件** | ❌ | 例如 pi 的 extensions、Claude 的 hooks，无对等概念，不代管 |
| 会话 / 历史 / 缓存 / 凭据文件 | ❌ | 运行时数据，永不触碰 |
| output-styles / themes | ❌ | 无对等概念 |

完整的受管路径清单见 `bridge/targets/*.json` —— **清单是唯一的结构知识来源**，代码里没有"猜路径"的逻辑。清单里没有的东西，本项目一律不碰。

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
* **不替你做决定**：默认不 adopt 任何 agent；要不要桥接、撤回，都由你显式发起。
* **不支持 Windows 原生**（路径约定与符号链接语义差异大）。

## 与符号链接方案的区别

把通用技能目录软链到 Claude 的技能目录，确实能"少抄一遍"，但：无法逐文件审计（说不清哪几个文件漂移了）、无法回滚、Windows 不可用、还可能被目标端工具整目录重写后静默失效。

本工具用**复制 + 逐文件哈希比对**，换来可审计（`diff`）、可回滚（`rollback`）、可撤回（`revoke`）——代价是 Claude 侧改动需要跑一次 `apply` 才生效（本项目不常驻、不监听）。

## 目录结构

```
bridge/         桥接器本体（Node 20+，零第三方依赖）
templates/      环境变量与目标端配置模板
docs/           架构决策记录（ADR）与使用手册
tasks/          按变更编号归档的 CHANGE / HEALTH / PRD / SPEC / TRACEABILITY
tests/          单元测试与 fixture
```

## 许可

MIT，见 `LICENSE`。
