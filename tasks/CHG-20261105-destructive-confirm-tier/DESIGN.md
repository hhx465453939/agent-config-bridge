# DESIGN · 破坏性操作的两层权限模型

> 面向开源后的审稿人：这份文档解释「为什么一个删除命令会被分成不同的命运」，
> 以及「授权为什么只能由用户亲手给」。
> 实现见 `bridge/gates/policy.js`（`unrecoverableTarget` / `effectiveDestructiveTier` /
> `no-destructive-bash` / `no-self-grant`）、`bridge/gates/pi/index.js`、`bridge/gates/dsh/index.js`。
> 决策记录见 `docs/ADR/012-destructive-confirm-tier.md`。

## 0. 一句话

删 `node_modules` 和删 `$HOME` 不是一回事；`git push --force` 和 `DROP DATABASE` 也不是一回事。
门控要回答的是两个不同的问题：

1. **删掉能不能恢复？** —— 不能恢复的，谁都别想放行（guardrail）。
2. **这件事用户授权了吗？** —— 能恢复但严重的，按类别问一句（permission）。

原来的实现只回答了「路径里有没有 build 字样」，所以两个问题都没答对。

## 1. 两层，不是三档

```
                        rm / git / dd / chmod / DROP …
                                    │
                                    ▼
                ┌───────────────────────────────────────┐
                │ 目标是构建产物 / 临时目录？              │──是──▶ allow（不问，直接跑）
                │ （node_modules, dist, build, .venv…）  │
                └───────────────┬───────────────────────┘
                                │ 否
                                ▼
                ┌───────────────────────────────────────┐
                │ GUARDRAIL：删掉不可恢复？               │
                │  根 / 顶层目录 / $HOME 及祖先 /        │──是──▶ 硬拦（任何授权无效）
                │  cwd 及祖先 / 含 .. / git 仓库根 /     │
                │  磁盘格式化 / 裸设备写入 / 关机重启     │
                └───────────────┬───────────────────────┘
                                │ 否
                                ▼
                ┌───────────────────────────────────────┐
                │ PERMISSION：类别 = ?                   │
                │  allow   → 直接跑（用户已授权）        │
                │  confirm → 问一句（默认）              │
                │  deny    → 拒绝（用户主动收紧）        │
                └───────────────────────────────────────┘
```

七个可授权类别：

| 类别 | 覆盖 |
|---|---|
| `delete` | `rm` / `rmdir` / `unlink` / `del` / `rd /s` / `Remove-Item -Recurse` / `find -delete` / `clear-content` |
| `git-history` | `reset --hard` / `clean -f` / `checkout -- .` / `restore` / `branch -D` / `filter-*` / `stash drop\|clear` |
| `git-force-push` | `push --force` / `--force-with-lease` / `-f` |
| `db-ddl` | `DROP TABLE\|DATABASE\|SCHEMA` / `TRUNCATE TABLE`（默认 `deny`） |
| `perm-recursive` | `chmod -R` / `chown -R` / `chgrp -R` |
| `process-kill` | `taskkill /F` |
| `raw-write` | `dd of=<普通文件>`（裸设备是 guardrail） |

**`git-force-push` 单独成一类**，而不是并进 `git-history`：用户可能信任 agent 重置自己的工作区，
但不信任它改写远端共享历史。授权粒度必须能表达这个差别。

**`db-ddl` 默认 `deny`**：被 drop 掉的 schema 是这里唯一一类经常超出备份覆盖范围的东西。
想用就 `/gate grant db-ddl`，那是用户的一次明确动作，不是默认值顺手给的。

## 2. 为什么 `..` 要在归一化之前判

`resolveShellPath()` 用 `path.normalize()`，它会把 `..` 消掉：

```
cwd = /srv/project
rm -f data/../notes.txt   →  normalize →  /srv/project/notes.txt   （看起来完全无害）
```

但 `rm -rf data/../..` 归一化后是 `/` —— 一个 `..` 就能从项目目录逃到根。
所以 `unrecoverableTarget` 先看**原始 token** 里有没有 `..` 段，再看归一化结果。

这也是测试用 `data/../notes.txt` 而不是 `/data/xx/../..` 做断言的原因：
后者归一化后就是 `/`，两种实现都判红线，测不出 token 判定到底在不在。

## 3. 授权优先级：收紧永远赢过放松

```
policy deny    → deny    用户说了「永远不行」，本会话授权不能翻案
session deny   → deny    本会话可以比 policy 更严格
session allow  → allow   弹窗里选的「本会话允许这一类」
policy allow   → allow   /gate grant 给的持久授权
默认           → confirm
```

**不对称是故意的。** 如果放松赢，agent 只要在一轮对话里说服用户给一次会话授权，
就能顺带推翻一条永久 `deny`。那样「永久」两个字就没有意义。

## 4. 授权只能用户亲手给

这是整个设计的安全边界。授权表存在两个文件里：

- `~/.config/agent-config-bridge/gate-policy.json`（持久，机器本地）
- `<extension_dir>/enforce-rules/policy.json`（安装产物）

如果 agent 能改其中任何一个，上面所有分层都变成装饰——它给自己 `allow db-ddl` 就绕过了门控。
所以新增 `no-self-grant` 检查：

| 动作 | 结果 |
|---|---|
| `write` 目标命中上述文件，且内容含 `destructive_grants` | 拦（`GATE_SELF_GRANT`） |
| `write` 同一文件但改的是别的字段 | 放行（只保护授权表，不锁死整个文件） |
| bash 重定向 / `sed -i` / `tee` 写上述文件 | 拦 |

授权的合法通道只有两个，都是**用户触发**：

1. **交互弹窗三选一**：`允许这一次` / `本会话允许这一类` / `拒绝`
2. **`/gate` 命令**：`list` / `grant <类别>` / `ask <类别>` / `deny <类别>` / `reset <类别>` / `session <类别>`

agent 能做的是**提议**（"你可以敲 /gate grant git-force-push"），不是执行。

`no-self-grant` 放进 `HARD_CHECKS`：如果它受 block cap 影响，agent 花光额度后就能自己提权。

## 5. 为什么持久授权不写 policy.json

`bridge apply` 会重新生成安装目录的 `policy.json`。写在那里的授权会在下一次 apply 时被静默抹掉。
机器本地覆盖文件 `~/.config/agent-config-bridge/gate-policy.json` 是 bridge 已经支持的
override 源（`readMachineOverride`），apply 时会合并进去，所以授权能活过 apply。

adapter 启动时再调一次 `applyMachineOverride`，让 `/gate` 的改动**立即**生效，不必等下一次 apply。

## 6. 两端为什么不一样

| | pi | dsh |
|---|---|---|
| 钩子 | `pi.on('tool_call', async (event, ctx) => …)` | `ctx.on('tools/pre-execute', async (exec, next) => …)` |
| 能问用户吗 | 能，`ctx.ui.select()` 三选一 | 不能，只有 `deny` / `next` |
| confirm 档 | 弹窗；拒绝 → block | `next()`（执行） |
| deny / guardrail | block | deny |
| 能改授权吗 | 能，`/gate` 命令 | 不能（无命令通道），只能读 apply 后的 policy.json |

pi 本身不弹确认（`docs/security.md` 明说 "it does not ask for approval before every tool call"），
所以「问」这件事必须由扩展做。dsh 的 pre-execute 没有 UI 通道，物理上问不了，只能放行；
**guardrail 与 deny 两端都拦**，所以「不可恢复」和「用户已禁止」这两层不存在差异。

无 UI 的 pi（headless / 脚本调用）也走放行，并写一行 stderr：

```
[enforce-rules] DESTRUCTIVE_CONFIRM auto-approved (no UI) [delete]: rm -f /srv/project/notes.txt
```

## 7. 回退

`policy.json` 的 `config.destructive_confirm_mode: false` → 所有 confirm 档回到硬拒，
等价于 2026-11-05 之前的行为。guardrail 与 `deny` 档不受这个开关影响（它们本来就不问）。

## 8. 测试怎么证伪

| 断言 | 怎么让它变红 |
|---|---|
| 普通删除是 confirm | 让 `rm` 分支返回红线 |
| `$HOME` / cwd / `..` 是红线 | 删掉 `unrecoverableTarget` 的对应分支 |
| 全部类别都授权，红线仍拦 | 让 guardrail 也走 tier 判定 |
| `node_modules` 仍 allow | 删掉 `isDisposablePath` 过滤 |
| 授权生效 | 忽略 `destructive_grants` |
| 收紧赢过放松 | 让 session allow 覆盖 policy deny |
| agent 不能自我提权 | 去掉 `no-self-grant` |
| pi 真弹窗三选一 | 把 confirm 直接当放行 |
| dsh 降级 | 只改 pi 不改 dsh |
