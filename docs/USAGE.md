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

* 快照存在**仓库内**的 `.bridge/snapshots/gemini/<时间戳>/`（权限 700，已被 `.gitignore` 排除）；
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

### 5.8 为什么 MCP 配置明明对，工具却不见了

有些 agent 的 MCP 支持**不是一个内建功能，而是一个包**。pi 就是这种：pi 本体没有 MCP，桥接器生成的 `~/.pi/agent/mcp-adapter.json` 只有 `pi-mcp-adapter` 这个包会读。

问题在于那个包记在 `~/.pi/agent/settings.json` 的 `packages` 里 —— 而 `settings.json` 是本项目的 `never_touch`（你自己 `pi install` 装的东西，工具无权替你决定）。于是出现一个**结构性盲区**：

* 配置在盘上、内容正确、权限 600，`apply` 每次都报成功；
* 但没有任何程序去读它 —— MCP server、`codebase-memory` 直连工具、以及依赖这些工具名的硬闸门**一起静默消失**；
* pi 重装、清了 npm 缓存、或换台机器只跑了 `adopt`/`apply`，就会发生。

本项目的处理方式是**声明 + 探测**，而不是替你去装（那会写 `never_touch`，属于越界）：

* 需要外部程序的受管条目在清单里声明 `requires`（探针路径 + 装法 + 说明）；
* `doctor` 在"该端已桥接、且它生成的那份配置确实存在"时探测一次，缺失就报 `REQUIREMENT_MISSING`（**warn**），并把修复命令原样打出来：

```
WARN
  [REQUIREMENT_MISSING] pi: pi-mcp-adapter is not installed, so ~/.pi/agent/mcp-adapter.json
  is generated but nothing loads it — pi has no built-in MCP support, ...
      → pi install npm:pi-mcp-adapter
```

几点刻意的设计：

* 判定为 **warn 而不是 error** —— 桥接器自己的产物没坏，`apply` 也仍然是正确动作；它只是"生产了没人读的东西"。`doctor` 普通模式仍退出 0，CI/巡检想当失败处理就加 `--strict`；
* **只写在 `doctor`，不写进 planner** —— `plan`/`apply` 必须是"源 + 目标"的确定性函数，否则快照测试与可复现性都会崩。"这台机器上装没装某个包"是环境事实，只配出现在自检里；
* 探针是**清单里的相对路径**，库里没有任何 pi 专属代码；任何端都可以声明任何伴随程序，`unless` 用来登记"也可以装在这儿"的备选位置，避免误报；
* 只在**已桥接且目标文件存在**时检查 —— 没 adopt 过的机器上不该被这种建议打扰。

> 你已经会手动 `pi install` 的话，这条的收益不是"帮你装"，而是把一次**毫无报错的静默失效**变成一条每次跑 `doctor` 都会重刷、且带修复命令的提示。

### 5.9 为什么 1M 上下文的模型显示成 128K

`contextWindow` 在 pi 里**不是装饰**：pi 用它算上下文预算，并据此决定**什么时候压缩会话**。写小了 → 模型明明有 1M，pi 提前把上下文压掉、能力白扔且不报错；写大了 → 请求超限报错。

pi 正常从 provider 学这个数（`pi-ai/dist/providers/data/*.json`）。**但走网关的自定义 provider 不在其中**：它的上下文窗口只能由本机那个 `extension.ts` 手写声明，而网关的 `/v1/models` **只返回 id**，没有任何元数据可读。

更麻烦的是还有第二份副本：pi-smart-router 的 `~/.pi/agent/pi-router-catalog.json`。它的合并逻辑是**粘性**的：

```ts
contextWindow: existing?.contextWindow ?? info.contextWindow
```

`existing` 永远赢，而它只在文件为空时才被写入 —— 也就是说，**一个写错的值永远不会被刷新**。

于是同一件事有两个手抄副本，在两个互不通信的文件里。`doctor` 现在会比一遍：

```bash
node bridge/cli.js doctor
```

```
WARN
  [PI_CATALOG_CONTEXT_STALE] pi-router catalog: shudie/kimi-k3: contextWindow 262144
  but family "kimi-k3" is 1048576 (pi-ai/dist/providers/data/moonshotai.json + kimi-coding.json)
      → the catalog merge is sticky (an existing value always wins), so this will not
        self-heal — edit pi-router-catalog.json
```

几点刻意的设计：

* **只报告，不重写。** 那两个文件都不是本项目的：一个是用户写的程序，一个是 pi-smart-router 的私有状态。把它们改成跟一个公开仓库里的表一致，正是本项目在别处反复拒绝的"静默权威"；
* 判定为 **warn** —— 桥接器自己的产物没坏，`apply` 仍是对的；普通 `doctor` 退出 0，`--strict` 才算失败（供 CI 用）；
* 出处不是"官网写着"，而是**pi 自己发布的那份数据文件**。测试直接读机器上 pi 的真实文件比对，不是读一份抄好的 fixture —— 抄两遍同一个错，测试永远绿；
* 表里**没有任何网关域名、端口、密钥**。归类只看 model id 前缀，而 id 是公开信息；
* 反例是被**声明**的，不是碰巧的：`glm-5.1` 是 200K 不是 1M、`claude-opus-4-5` 是 200K 不是 1M、`kimi-k3-256k` 比 `kimi-k3` 小 —— 这几条都有专门的用例钉住；
* **查不到就不猜。** 本机任何权威来源里都没有的型号（如某些 qwen）不会被报出来，也不会被编一个数字填上。宁可少报。

> 表在 `bridge/lib/pi-models.js`，维护方式见 `docs/ADR/005-pi-model-context-metadata.md`。要加一个家族：加一行（**必须带 `source`**），在 `FAMILY_PROBES` 里加一条探针，测试就自动开始盯它。

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
| **硬闸门（gate）** | ✅ | 仅对有扩展机制的 agent（pi、dsh）；Kimi 无此机制，`status` 会明说 |
| **各端私有设置** | ❌ 保留 | 模型选择、主题、快捷键、权限白名单、非 MCP 段配置 |
| **各端扩展 / 插件** | ❌ | 你自己写的扩展原样保留；本工具只往里加它自己那一个子目录 |
| 会话 / 历史 / 缓存 / 凭据文件 | ❌ | 运行时数据，永不触碰 |
| output-styles / themes | ❌ | 无对等概念 |

完整的受管路径清单见 `bridge/targets/*.json` —— **清单是唯一的结构知识来源**，代码里没有"猜路径"的逻辑。每个清单还带一份 `never_touch`（该端私有、永不接管）。清单里没有的东西，本项目一律不碰。

## 6.1 硬闸门（gate）：让规则文档真的被遵守

规则文档是建议，有些规则却必须真的执行 —— 比如「读源码前先查代码图谱」。本项目把这类规则给**有扩展机制的 agent** 装成工具级拒绝。

| Agent | 硬闸门 | 你需要做什么 |
|---|---|---|
| **pi** | ✅ | 什么都不用做：`adopt pi` 后 pi 会自动加载 |
| **DeepSeek Harness** | ✅ | `adopt dsh` 会把闸门装到 `~/.dsh/plugins/`，但 **dsh 不会自动加载**。你需要在自己的 cordis 组合里加一行（`status` 与装好的 `README.md` 里都写了现成的一行） |
| **Kimi Code** | ❌ | 它没有用户可装的扩展/钩子机制，规则对它仍是建议 |

装到哪个目录、装了什么文件，都可以直接看：

```
~/.pi/agent/extensions/enforce-rules/
  policy.js      规则引擎
  policy.json    策略（想改就改这个）
  index.js       pi 入口
  pi/index.js    适配层
  README.md      它是什么 + 如何卸载
```

想改规则（换检查项、改作用范围、改"一个会话最多拦几次"）→ 直接编辑 `policy.json`。改了之后跑一次 `apply` 会被还原 —— 因为它是受管文件；如果你想长期用自己那版，改仓库里的 `bridge/targets/<agent>.json` 的 `gates.policy` 覆盖块。

安全的默认值：

* 策略文件坏了 → **放行**并告警，不会把 agent 卡死；
* 一个会话最多拦 3 次，之后放行；
* 不让工具碰你自己写的扩展 —— `revoke` 只删它装的那一个子目录；
* 检查按 **Layer 2（索引）→ Layer 1（图谱）** 的次序级联，次序就是 `policy.json` 里 `checks` 数组的顺序；调换先后会让"未建索引"被误报成"索引已就绪、去查图谱"（两个 Layer 2 检查都会在成功查过图谱后自动让行，不会把听话的会话反复拦）。

## 7. 安全说明

* 仓库内**永远**只有 `${VAR}` 占位符，没有真实值；
* 真实值只在 `~/.config/agent-config-bridge/secrets.env`，权限 `600`；
* 生成的目标配置可能含展开后的真实值，因此写入后会被 `chmod 600`；
* `state.json` 权限 600；快照与备份目录权限 700，两者都在仓库检出目录的 `.bridge/` 下（不会入库）；
* 桥接器会屏蔽输出中的疑似 token 串，但**请不要把完整输出贴到公开场合**。

## 8. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 某端完全没被同步 | 它还是 `native`（默认） | 先 `adopt <agent>` |
| 某端显示"未检测到" | 该 agent 目录不存在 | 先启动一次该 agent，再 `status` 确认 |
| **`doctor` 报 `REQUIREMENT_MISSING`** | 该端读配置的**程序**没了（配置本身是好的） | 按 `doctor` 给出的 → 命令装回来，例如 `pi install npm:pi-mcp-adapter`；详见 §5.8 |
| **`doctor` 报 `PI_CATALOG_CONTEXT_STALE`** | pi-smart-router 目录里某个模型的上下文窗口和 pi 发布的数据不一致，且它**不会自己刷新** | 按报错里的 `selector` 与期望值改 `~/.pi/agent/pi-router-catalog.json`；详见 §5.9 |
| **`doctor` 报 `PI_MODEL_TABLE_STALE`** | 本项目自己的家族表（`bridge/lib/pi-models.js`）跟不上 pi 发布的 provider 数据了 | 这是**仓库的**问题：按报错里的 `file` 与两个数字更新 `FAMILY_META`，并确认 `source` 仍准确 |
| **`doctor` 报 `PI_CATALOG_UNREADABLE`** | `pi-router-catalog.json` 不是合法 JSON | 修好它，或删掉（pi-smart-router 会回落到自带 seed） |
| `apply` 报"缺少环境变量 X" | `secrets.env` 未填该变量 | 填上，或从配置里移除该引用 |
| `revoke` 报"快照不完整" | 快照被手工删改 | 按报错列出的路径手工恢复；不要指望工具硬撑 |
| pi 里闸门没生效 | 扩展目录未被加载或 pi 未 reload | 重启 pi 或 `/reload`；在 pi 里跑 `/status` 看已加载扩展 |
| dsh 里闸门没生效 | dsh 不自动加载扩展目录 | 按装好的 `README.md` 里那行把闸门挂进 cordis 组合 |
| 闸门拦得太狠 / 该拦的没拦 | 策略配置不合你的习惯 | 改 `policy.json`（检查项、作用范围、拦截上限），或改仓库清单里的 `gates.policy` 覆盖块 |
| `doctor` 报"检测到符号链接" | 受管路径被换成了指向别处的链接 | 若是 pi 的 `~/.agents/skills`：删掉它，`adopt`/`apply` 会自动重建指向 `.claude/skills` 的链接；其他路径按 `doctor` 的修复提示处理 |
| `apply` 后 `diff` 仍非 0 | 目标端被别的工具改写 | 看 `diff` 详情；若该端有自管机制，把对应路径从清单移除 |
| `status` 说状态文件损坏 | `state.json` 被写坏 | 修好它，或删掉（删掉=回到全部 native） |

## 9. 关于技能链接与既有软链方案

pi 的 `~/.agents/skills` 是本项目唯一一条**声明式链接**：它必须指向 `~/.claude/skills`。

* 链接不存在时，`adopt`（或此后的 `apply`）会**自动创建**：POSIX 用符号链接，Windows 用 junction（免管理员权限）；
* 链接存在但指向别处、或那个位置是个真实目录时，`plan` 会**拒绝执行**，并在报错里给出对应平台的修复命令；
* 它和其他受管内容一样被快照、被 `doctor` 校验，`revoke` 会删掉工具创建的那条链接。

如果你此前用**没人管理的**符号链接（比如把某个 agent 的整个技能目录指向 Claude 技能目录）：

* 它**能用**，但无法逐文件审计、无法回滚，且可能被目标端工具整目录重写而静默失效；
* 本工具**不会**自动删除你的软链；
* 想切换到复制式管理：先删除软链，再 `adopt` 对应 agent；
* 切换后 Claude 侧改动不再立即生效，需要跑一次 `apply`（换来的是可审计、可回滚、可撤回）。
