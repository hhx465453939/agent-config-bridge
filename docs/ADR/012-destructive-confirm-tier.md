# ADR-012 — 破坏性命令的三档分级：high / confirm / allow

- 状态：已采纳
- 日期：2026-11-05
- 关联：CHG-20261105-destructive-confirm-tier、ADR-003（策略层与适配层分离）、ADR-010（破坏性动词匹配）

## 背景

`no-destructive-bash` 原先只有两种结局：命中 `destructive_allow_patterns` 就放行，
否则 `return { code: 'DESTRUCTIVE_BASH' }` 硬拒。

真实后果：`rm -f` 一个 agent 自己刚创建的临时文件也被拒，清理任务只能退化成
`mv` 到暂存区，磁盘空间释放不掉。用户已经明确授权删除，仍然不让删。

问题的形状不是「白名单配少了」，而是**判定模型缺少一档**：
「可丢弃」（`node_modules`/`dist`）和「不许删」之间，没有「问一句」。

## 决策

把判定结果拆成三档：

| 档 | 判据 | 行为 |
|---|---|---|
| `allow` | 目标路径含 `destructive_disposable_segments` 的段（`node_modules`、`dist`、`build`、`.venv`、`tmp` …） | 不产生 finding，直接执行 |
| `confirm` | 删除的是明确目标，且可恢复 | 适配层询问用户；无 UI 时执行并记一行 stderr |
| `high` | 删除后不可恢复 | 硬拒，与改动前完全一致 |

`high` 的判据（`unrecoverableTarget`）：

1. 原始 token 含 `..` 段
2. 解析后是 `/` 或盘符根
3. 解析后路径段数 ≤ 1（`/tmp`、`/usr`、`/home` 这类顶层目录）
4. 等于 `$HOME` 或是 `$HOME` 的祖先
5. 等于 cwd 或是 cwd 的祖先（删祖先会连带删掉 cwd）
6. 目标是一个 git 仓库根（可选探针 `isGitRepo`）

另有整类命令无条件 `high`：git 历史重写（`reset --hard` / `clean -f` / `checkout -- .` /
`restore` / `push --force` / `branch -D` / `filter-branch` / `filter-repo` / `stash drop|clear`）、
磁盘与主机级（`mkfs*` / `fdisk` / `parted` / `diskpart` / `format` / `format-volume` /
`shutdown` / `reboot` / `poweroff` / `halt` / `init 0|6` / `Stop-Computer` / `taskkill /F` /
`dd of=<非 /dev/null>`）、数据库级（`DROP TABLE|DATABASE|SCHEMA` / `TRUNCATE TABLE`）。

## 为什么不用 ISSUE 推荐的做法（confirm 档直接 `return null`）

ISSUE 的建议是「交给 pi 原生工具确认」。这个前提**不成立**：

> pi 1.2.0 `docs/security.md`：Pi can read, change, and execute files with the permissions
> of the account that started it, and it does **not ask for approval** before every tool call.

照做的话，结果是从「一律拒绝」变成「一律放行」——用户要的「问一句」根本没实现，
安全底线反而没了。**把过严换成裸奔，比不改更危险。**

pi 确实有确认能力，只是必须由扩展发起。`docs/extensions.md` 的 permission extension
示例即 `await ctx.ui.confirm(...)` + `return { block: true, reason }`，
而 `bridge/gates/pi/index.js` 的 `pi.on('tool_call', async (event, ctx) => …)` 本来就是 async。

## 端能力差异（写明，不假装一致）

| 端 | confirm 档的处理 | 原因 |
|---|---|---|
| pi | `ctx.ui.confirm()` 弹窗；拒绝 → block；允许 → 执行 | `tool_call` 是 async，`ctx.ui.confirm` 可用 |
| pi（无 UI） | 执行 + stderr 一行 `DESTRUCTIVE_CONFIRM auto-approved` | 自动化调用已由调用方授权；弹窗永远等不到，阻塞等于把门控变成不可用 |
| dsh | `next()`（执行） | pre-execute 只有 `deny` 和 `next`，没有 UI 通道 |

两端 `high` 档都硬拒，所以「不可恢复」这一层不存在差异。

## 被否方案

### 方案 B：放宽 `isDisposablePath`（ISSUE 备选）

把「深度 ≥2、不含 `..`、不在 `$HOME`/cwd 祖先链上的单文件删除」直接当非破坏性放行。
否决理由：**静默放行**。用户不会知道刚才删了什么，误删重要配置单文件也毫无提示。
「问一句」和「不问就做」是两回事。

### 方案 C：配置 `destructive_allow_patterns` 应急

在 `policy.json` 里堆正则放行眼前的任务。否决理由：等于「要么全拒要么裸奔」，
而且每台机器、每个任务都要加一条，正则本身成为新的风险面。只能当临时手段。

### 方案 D：判断「文件是不是 agent 自己创建的」

静态解析无法可靠判定（无法区分「本会话创建」和「上一会话遗留」）。
假装能判会制造虚假安全感。不做（SPEC N-1）。

## 已知边界（接受，不粉饰）

1. **`/tmp/<任意>` 仍是 `allow`**：`tmp` 在 `destructive_disposable_segments` 里，这是既有行为，
   本次不改（N-3）。`/tmp` 顶层目录本身是 `high`（段数 ≤ 1）。
2. **`$VAR` 路径不判 `high`**：解析不了就不猜，落到 `confirm`。猜测式硬拦会误伤
   解析器只是没看懂的正常命令。
3. **`isGitRepo` 默认不探测**：`policy.js` 保持 disk-free（测试可注入虚拟文件系统）。
   adapter 才注入基于 `realFs.exists` 的实现。
4. **`confirm` 不消耗 block cap**：确认不是拒绝。让它计数会让几次普通删除花光会话的规则预算。

## 后果

正向：

- 日常清理恢复可用，磁盘空间能真正释放。
- 「不可恢复」的红线一条没松：AC-2…AC-5、AC-7、AC-10b 全部仍硬拒。
- 用户对普通删除有知情权（弹窗），而不是被静默放行或静默拒绝。
- 一键回退：`destructive_confirm_mode: false`。

负向 / 需接受：

- 交互会话里普通删除会多一次弹窗。这是设计目标，不是副作用。
- 无 UI 的自动化会执行可恢复删除而不询问。已在 stderr 留痕；不可恢复的仍拦。
- dsh 端「问一句」物理上做不到，只能放行。若要一致，需要 dsh 提供 UI 通道。

---

## v2 修订（2026-11-05，用户追加需求）—— 两层模型取代三档描述

上一节的「三档」描述已被本修订取代。三档把「严重程度」当成唯一维度，于是
`git reset --hard` 和 `rm -rf $HOME` 落在同一档，用户既不能授权前者，也不能更严格地禁止后者。

### 修订后的决策

破坏性操作分**两层**，因为它们是两个不同的问题：

| 层 | 问题 | 可否授权 |
|---|---|---|
| **guardrail** | 删掉能不能恢复？ | **不可**。任何 grant 无效 |
| **permission** | 用户授权了吗？ | **可**。七个类别，每类三档 |

七个类别：`delete`、`git-history`、`git-force-push`、`db-ddl`、`perm-recursive`、
`process-kill`、`raw-write`。默认档：`db-ddl` 为 `deny`，其余为 `confirm`。

**`git-force-push` 单独成一类**：信任 agent 重置自己的工作区，和信任它改写远端共享历史，
是两件不同的事，授权粒度必须能表达这个差别。

**`db-ddl` 默认 `deny`**：被 drop 的 schema 经常超出备份覆盖范围。要用就 `/gate grant db-ddl`，
那是用户的一次明确动作。

### 授权优先级：收紧赢过放松

```
policy deny → deny    永久拒绝，会话授权不能翻案
session deny → deny   会话可以比 policy 更严格
session allow → allow
policy allow → allow
默认 → confirm
```

不对称是故意的。若放松赢，agent 在一轮对话里拿到一次会话授权，就能顺带推翻永久 `deny`。

### 为什么授权只能用户亲手给

授权表在两个文件里：`~/.config/agent-config-bridge/gate-policy.json` 与安装版 `policy.json`。
若 agent 能改任何一个，上面所有分层都是装饰。所以新增 `no-self-grant`：

- `write` 或 bash 写这两个文件且内容含 `destructive_grants` → `GATE_SELF_GRANT` 硬拦
- 同一文件改其它字段 → 放行（只保护授权表，不锁死整文件）
- 列入 `HARD_CHECKS`：受 block cap 影响的话，agent 花完额度就能自己提权

合法通道只有两个，都是用户触发：交互弹窗三选一、`/gate` 命令。agent 只能**提议**。

### 持久授权为什么不写 policy.json

`bridge apply` 会重新生成安装版 `policy.json`，写在那里的授权会被静默抹掉。
机器本地 override（`readMachineOverride` 已支持）能活过 apply，adapter 启动时再
`applyMachineOverride` 一次，让 `/gate` 立即生效。

### 新增的已知边界

5. **`registerCommand` 不存在时丢失 `/gate`**：旧宿主或测试桩没有命令 API，只丢授权命令，
   门控照常执行。这是刻意选择：缺能力降级一个功能，不能把安全层一起带走。
6. **dsh 无法调整授权**：没有命令通道，只能读 `apply` 后的 `policy.json`。要一致需要 dsh 提供命令通道。
