# 使用手册

> 面向使用者。开发约定见 `CONTRIBUTING.md`，架构决策见 `docs/ADR/001-bridge-architecture.md` 与 `docs/ADR/002-opt-in-and-revoke.md`。

## 1. 前提

* Node.js ≥ 20
* 至少装了 Claude Code（它扮演"权威源"角色）
* 你想桥接的其他 agent 已至少启动过一次（各自的全局目录已被自身创建）

## 2. 首次配置

```bash
git clone <仓库地址> ~/Development/agent-config-bridge
cd ~/Development/agent-config-bridge

# 密钥外置：仓库内只有占位符，真实值放这里（不在仓库中）
mkdir -p ~/.config/agent-config-bridge
cp templates/secrets.env.example ~/.config/agent-config-bridge/secrets.env
chmod 600 ~/.config/agent-config-bridge/secrets.env
$EDITOR ~/.config/agent-config-bridge/secrets.env
```

> `secrets.env` 里只需要填**你实际用到的**变量。没填但被配置引用的变量会导致同步在该条目上失败（fail-closed），不会写入空值。

## 3. 三个状态

**默认什么都没有接管。** 这是刻意的：项目不会替你决定桥接谁。

| 状态 | 含义 | 本项目的行为 |
|---|---|---|
| `native` | **默认**。该 agent 用自己的原生全局配置 | 一个字节都不改 |
| `bridged` | 你显式 `adopt` 过 | 受管清单内的文件跟随 Claude Code |
| `revoked` | 曾桥接、已撤回 | 已恢复原生配置，保留一条记录备查 |

```
                  adopt                  revoke
   native  ────────────────►  bridged  ────────────────►  revoked
   （默认，不改）              （跟随权威源）              （已恢复原生）
                                 ▲                            │
                                 └────────── adopt ───────────┘
```

## 4. 常用命令

```bash
node bridge/cli.js status            # 看这台机器上各 agent 的状态（不写盘）
node bridge/cli.js adopt gemini      # 让 gemini 跟随 Claude Code（先快照，再首次同步）
node bridge/cli.js plan              # 看会改什么（不写盘）
node bridge/cli.js apply             # 真的同步（覆盖前先备份）
node bridge/cli.js diff              # 只看漂移（不写盘）
node bridge/cli.js revoke gemini     # 撤回，把 gemini 恢复成它自己的原生配置
node bridge/cli.js doctor            # 环境自检
node bridge/cli.js rollback          # 退回最近一次同步之前
```

日常推荐顺序：`status` → `plan` → 确认 → `apply` → `diff`（应为 0 漂移）。

**只有 `bridged` 状态的 agent 会被 `plan`/`apply`/`diff` 处理。** 其余一律打印"未接管，跳过"。

## 5. 日常场景

### 5.1 我想让某个 agent 跟随 Claude Code

```bash
node bridge/cli.js status            # 先确认它当前是 native
node bridge/cli.js adopt gemini      # 会先给它的现有配置拍快照，再首次同步
```

* 快照存在 `~/.local/state/agent-config-bridge/snapshots/gemini/<时间戳>/`，权限 700；
* 只有它被改动，其他 agent 的文件 md5 完全不变；
* 它自己的私有配置（模型选择、主题、快捷键、权限）**原样保留**。

### 5.2 我不想让它跟随了

```bash
node bridge/cli.js revoke gemini
```

* 按 adopt 时的快照**逐字节恢复**；
* 快照不完整时会**明确报错并拒绝执行**——不会给你一个"看起来还原了其实没有"的假象；
* 如果你自己删了快照，那就只能手工恢复了（工具会告诉你要恢复哪些路径）。

### 5.3 我新写了一个 skill

1. 在 Claude Code 侧正常创建：`~/.claude/skills/<新技能名>/SKILL.md`
2. `node bridge/cli.js apply`
3. 完事。**所有处于 `bridged` 状态**的 agent 会自动获得该 skill。

**不要**直接往其他 agent 的目录里放 skill（若它已 bridged，下次 `apply` 会覆盖）；若它是 native，那随便你，本项目不管。

### 5.4 我改了全局规则文档（开发习惯 / 记忆）

1. 改 Claude Code 侧的规则主文档
2. `node bridge/cli.js apply`
3. 所有 bridged agent 的全局规则文档同步为一致内容。
4. native agent 的规则文档不动。

### 5.5 我加了一个 MCP server

1. 在 Claude Code 里正常加
2. 若需要密钥，先写进 `~/.config/agent-config-bridge/secrets.env`
3. `node bridge/cli.js apply`
4. bridged agent 获得等价配置；产物权限 600。

> **你自己在目标端手工加的 MCP server 不会被删**——同步只覆盖"由权威源派生的条目"。

### 5.6 我搞坏了，想退回去

```bash
node bridge/cli.js doctor                     # 先看现状
node bridge/cli.js rollback                    # 退回最近一次同步之前
node bridge/cli.js rollback 20260927T101500    # 或指定一次备份
```

回滚自身也先把当前状态备份一次，所以可以退回再退。

### 5.7 换新机器

```bash
git clone <仓库地址> ~/Development/agent-config-bridge
cd ~/Development/agent-config-bridge
cp templates/secrets.env.example ~/.config/agent-config-bridge/secrets.env
chmod 600 ~/.config/agent-config-bridge/secrets.env && $EDITOR ~/.config/agent-config-bridge/secrets.env
node bridge/cli.js status          # 看这台机器上有哪些 agent
node bridge/cli.js adopt <你想要的>
node bridge/cli.js plan
node bridge/cli.js apply
```

* 某端目录不存在 → 跳过并告警，不会替你创建整套目录（先装上该 agent 再同步）；
* 新机器上默认全部 native，需要你重新选择（这是刻意的：不同机器可能有不同取舍）。

## 6. 会桥接什么、不会碰什么

| 维度 | 是否桥接 | 说明 |
|---|---|---|
| skills | ✅ | 目录形式的技能（`SKILL.md` 规范），逐文件比对复制 |
| 斜杠命令 / 提示词模板 | ✅ | 各端文件格式做适配 |
| 子 agent 定义 | ✅ | 目标端支持时桥接，不支持则报告跳过 |
| 全局规则文档（开发习惯 / 记忆） | ✅ | 由权威源派生出各端镜像名 |
| MCP server 声明 | ✅ | 跨格式转换；密钥走仓库外的 `secrets.env`；**用户自有条目保留** |
| **各端私有设置** | ❌ 保留 | 模型选择、主题、快捷键、权限白名单、非 MCP 段配置 |
| **各端扩展 / 插件** | ❌ | 例如 pi 的 extensions、Claude 的 hooks，无对等概念，不代管 |
| 会话 / 历史 / 缓存 / 凭据文件 | ❌ | 运行时数据，永不触碰 |
| output-styles / themes | ❌ | 无对等概念 |

完整的受管路径清单见 `bridge/targets/*.json` —— **清单是唯一的结构知识来源**，代码里没有"猜路径"的逻辑。每个清单还带一份 `never_touch`（该端私有、永不接管）。清单里没有的东西，本项目一律不碰。

## 7. 安全说明

* 仓库内**永远**只有 `${VAR}` 占位符，没有真实值；
* 真实值只在 `~/.config/agent-config-bridge/secrets.env`，权限 `600`；
* 生成的目标配置可能含展开后的真实值，因此写入后会被 `chmod 600`；
* `state.json` 权限 600；快照与备份目录权限 700；
* 桥接器会屏蔽输出中的疑似 token 串，但**请不要把完整输出贴到公开场合**。

## 8. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 某端完全没被同步 | 它还是 `native`（默认） | 先 `adopt <agent>` |
| 某端显示"未检测到" | 该 agent 目录不存在 | 先启动一次该 agent，再 `status` 确认 |
| `apply` 报"缺少环境变量 X" | `secrets.env` 未填该变量 | 填上，或从配置里移除该引用 |
| `revoke` 报"快照不完整" | 快照被手工删改 | 按报错列出的路径手工恢复；不要指望工具硬撑 |
| `doctor` 报"检测到符号链接" | 你用软链把通用技能目录指向了 Claude 技能目录 | 见下节，自行决定是否改复制方案 |
| `apply` 后 `diff` 仍非 0 | 目标端被别的工具改写 | 看 `diff` 详情；若该端有自管机制，把对应路径从清单移除 |
| `status` 说状态文件损坏 | `state.json` 被写坏 | 修好它，或删掉（删掉=回到全部 native） |

## 9. 关于既有软链方案

如果你此前用符号链接（把通用技能目录直接指向 Claude 的技能目录）：

* 它**能用**，但无法逐文件审计、无法回滚、Windows 不可用、且可能被目标端工具整目录重写而静默失效；
* 本工具**不会**自动删除你的软链；
* 想切换到复制式管理：先删除软链，再 `adopt` 对应 agent。
* 切换后 Claude 侧改动不再立即生效，需要跑一次 `apply`（换来的是可审计、可回滚、可撤回）。
