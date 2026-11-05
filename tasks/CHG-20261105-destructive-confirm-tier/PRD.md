---
change_id: CHG-20261105-destructive-confirm-tier
status: approved
---

# PRD · 破坏性命令「问一句」，而不是「一律不许」

## 背景（用户可感知的故障）

`enforce-rules` 的 Layer 0 检查 `no-destructive-bash` 只有两种结局：命中白名单就放行，否则**硬拒绝**。
结果是 `rm -f` 一个自己刚创建的临时文件也被拒绝，agent 只能把文件 `mv` 到暂存区，磁盘空间释放不掉，
清理任务变成半成品。用户已经明确授权删除，仍然不让删。

用户的原话：「正常应该是和用户确认以后才能删，现在是我授权了也不给删」。

## 承诺

| # | 承诺 | 用户可感知的结果 |
|---|---|---|
| P-1 | 普通删除不再被一律拒绝 | `rm -f <具体文件>` / `rm -rf <明确目录>` 能执行，不再报 `DESTRUCTIVE_BASH` |
| P-2 | 不可恢复的删除仍然硬拦 | 删 `$HOME`、删当前工作目录、删顶层目录、含 `..` 的路径、`git reset --hard`、force push、`mkfs`/`fdisk`/`format`、`DROP DATABASE` 依然拦住 |
| P-3 | 交互模式下普通删除**真的问一句** | pi 会话里弹出确认框，用户点「允许」才执行；点「拒绝」则不执行并回一段说明 |
| P-4 | 自动化不被确认卡死 | 非交互运行（无 UI）时普通删除放行并在 stderr 留一行记录；P-2 的硬拦不受影响 |
| P-5 | 可回退 | `policy.json` 的 `destructive_confirm_mode: false` 一键回到「一律拒绝」的旧行为 |
| P-6 | 两端一致 | pi（有 UI）弹窗确认；dsh（pre-execute 无 UI 能力）降级为放行，并在代码注释与 ADR 里写明这是端能力差异，不是遗漏 |

## 不承诺

| # | 不做 | 原因 |
|---|---|---|
| N-1 | 不判断「这个文件是不是 agent 自己创建的」 | 静态解析无法可靠判定；假装能判会制造虚假安全感 |
| N-2 | 不做「跨机器同步授权」 | 授权是「这台机器 + 这个用户」的属性，不是仓库属性；随代码提交会变成集体授权 |
| N-3 | 不改 `isDisposablePath` 的既有语义 | `node_modules` / `dist` / `build` / `.venv` / `tmp` 等继续直接放行，不回归 |
| N-4 | 不把 `no-destructive-bash` 移出 `HARD_CHECKS` | 安全类检查不该受 block cap 影响；本次只改判定粒度 |
| N-5 | 不用「深度 ≤ N 就放行」这类猜测规则替代目标判定 | 猜测式放宽比明确分级更危险 |

## 验收口径

以 SPEC §8 的 AC-1…AC-14 与 §11.6 的 AC-15…AC-22 为准。任何一条从红变绿都必须有实测证据写进 `TRACEABILITY.md`。

## v2 追加承诺（用户补充需求）

> 「不仅仅是删除，还有 git push force 这种……整体逻辑分层，有些经过用户授权可以执行，有些坚决不行，
> 并且随时可以和 agent 商量，去调整哪些权限提权或者降权」。

| # | 承诺 | 用户可感知的结果 |
|---|---|---|
| P-7 | 破坏性操作分成「红线」与「可授权类别」两层 | 删 `$HOME` 永远不行；`git push --force` 可以授权 |
| P-8 | 七个可授权类别，每类三档（allow / confirm / deny） | 可以只授权强推、不授权删库 |
| P-9 | 用户随时能提权或降权，无需改代码 | `/gate grant\|ask\|deny <类别>`，或弹窗里选「本会话允许这一类」 |
| P-10 | agent 不能给自己提权 | 改授权表的写入被 `GATE_SELF_GRANT` 拦；agent 只能提议 |
| P-11 | 收紧优先于放松 | 永久 `deny` 不会被一次会话授权推翻 |

## 已确认的事实前提（不是假设）

1. **pi 1.2.0 原生不弹确认**：`docs/security.md` 原文 "it does not ask for approval before every tool call"。
   因此 ISSUE 里「交给 pi 原生工具确认」不成立 —— 必须由扩展自己调 `ctx.ui.confirm()`。
2. **pi 扩展有确认能力**：`docs/extensions.md` 的 permission extension 示例即
   `await ctx.ui.confirm("Allow tool call?", event.toolName)` 配合 `return { block: true, reason }`。
   `bridge/gates/pi/index.js` 的 `pi.on('tool_call', async (event, ctx) => …)` 已是 async，可直接 await。
3. **dsh 无确认能力**：`bridge/gates/dsh/index.js` 的 pre-execute 只有 `{ kind: 'deny' }` 与 `next()`，
   没有 UI 通道。降级方案见 P-6。
