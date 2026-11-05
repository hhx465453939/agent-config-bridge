---
change_id: CHG-20261105-destructive-confirm-tier
status: approved
---

# CHANGE · 改了什么、为什么

## 根因（第一性原理，不是照症状打补丁）

### R-1 判定是二值的，架构上不存在「需确认」这一档

`bridge/gates/policy.js` 的链路只有两种结局：

```
bashDestructiveFinding(command) -> finding | null
        │                            │
        │                            └─ no-destructive-bash 直接 return { code: 'DESTRUCTIVE_BASH' }
        └─ null -> 放行
```

`no-destructive-bash`（`policy.js:2413` 起）拿到 finding 就无条件返回 block 判定，**没有中间态**。
所以问题不在配置（`destructive_allow_patterns` 为空只是表象），而在判定模型缺少一档。

### R-2 「可丢弃」的判据太窄，且和「可恢复」不是同一件事

`isDisposablePath()`（`policy.js:1510`）只回答「这个路径里有没有 `node_modules`/`dist`/`build`/`.venv`/`tmp` 这类段」。
`data/raw/foo.tsv` 没有这些段，于是被当成和 `rm -rf src` 同级的危险动作。
但这两件事的风险完全不同：前者删一个中间文件，后者删源码树。

真正该问的是「**删掉之后能不能恢复**」，而不是「路径里有没有 build 字样」。

### R-3 ISSUE 里「交给 pi 原生工具确认」这个前提是错的

`ISSUE_destructive-gate-too-strict.md` §4 推荐把 confirm 档 `return null`，理由是「交给 pi 原生工具确认」。
实测 pi 1.2.0 的 `docs/security.md` 原文：

> Pi can read, change, and execute files with the permissions of the account that started it,
> and it does **not ask for approval** before every tool call.

即 pi 本身不弹确认。若照 ISSUE 直接 `return null`，结果是从「一律拒绝」变成「一律放行」，
用户要的「问一句」根本没实现 —— 这是**把过严换成裸奔**，比不改更危险。

正确的做法是扩展自己问：`docs/extensions.md` 的 permission extension 示例即
`await ctx.ui.confirm("Allow tool call?", event.toolName)` + `return { block: true, reason }`，
而 `bridge/gates/pi/index.js` 的 `pi.on('tool_call', async (event, ctx) => …)` 本来就是 async。

### R-4 dsh 端没有确认通道

`bridge/gates/dsh/index.js` 的 pre-execute 只有 `{ kind: 'deny' }` 和 `next()`，没有 UI。
所以「问一句」在 dsh 上物理上做不到，只能降级为放行；high 档仍然 deny。这是端能力差异，必须写明而不是假装一致。

## 改动

| 文件 | 改动 |
|---|---|
| `bridge/gates/policy.js` | 新增纯函数 `unrecoverableTarget()`；`finding()` 带 `severity`；`rm`/`del`/`rd`/`Remove-Item`/`clear-content`/`find -delete`/`chmod -R` 等「删具体目标」类分支改由目标判 high/confirm；git/磁盘/系统/数据库/dd 类一律 high；`bashDestructiveFinding` / `powershellDestructiveFinding` / `shellDestructiveFinding` 新增可选 `isGitRepo` 注入；`no-destructive-bash` 按 `severity` + `destructive_confirm_mode` 分级；`shouldBlock` 透传 `confirm` / `confirmReason` 且 confirm 不消耗 block cap；`DEFAULT_CONFIG` 增加 `destructive_confirm_mode: true` |
| `bridge/gates/pi/index.js` | bash 分支遇到 confirm 判定时：`ctx.hasUI` 且有 `ctx.ui.confirm` → 弹窗；拒绝 → block；允许 → 继续；无 UI → 放行并写 stderr 一行 |
| `bridge/gates/dsh/index.js` | bash 分支遇到 confirm 判定 → `next()`（无 UI 通道，high 仍 deny），注释写明端能力差异 |
| `bridge/gates/pi/policy.json` | `config.destructive_confirm_mode: true` |
| `bridge/gates/dsh/policy.json` | 同上（两端齐头并进） |
| `bridge/lib/gates.js` | 生成的安装 README 增加「破坏性命令三档」一节 |
| `bridge/test/gate-destructive.test.js` | 新增：AC-1…AC-12 的用例（策略层 + 两个 adapter 分支） |
| `docs/ADR/012-destructive-confirm-tier.md` | 新增：三档分级的决策、边界与端能力差异 |

## 未做

- 不判断「文件是不是 agent 自己创建的」（静态解析不可靠，N-1）。
- 不做持久化白名单 / 「本次会话不再问」（N-2）。
- 不改 `isDisposablePath` 与 `destructive_disposable_segments` 默认值（N-3）。
- 不把 `no-destructive-bash` 移出 `HARD_CHECKS`（N-4）。
- 不重构 `policy.js` 的解析器（既有债务，本 CHG 只加一个纯函数与少量分支）。

## 基线（实测，2026-11-05）

```
node --test bridge/test/*.test.js   # EXIT=0，222 tests / 221 pass / 0 fail / 1 skipped
```

## 复现方式（改前必红）

```bash
touch /tmp/t.txt && rm -f /tmp/t.txt   # 改前：被 no-destructive-bash 拦，报 DESTRUCTIVE_BASH
```

真实案例：清理 `data/raw/` 下 614 MB 下载失败副本时 `rm -f` 被拦，只能 `mv` 到暂存区，
磁盘空间要用户手动再跑一次 `rm -rf` 才能释放。

---

## v2（用户追加需求）：从「三档」升级为「两层 + 可协商授权」

### 追加需求原话

> 「不仅仅是删除，还有 git push force 这种，其实应该给这个破坏性功能整体逻辑分层，
> 有些经过用户授权可以执行，有些坚决不行，并且随时可以和 agent 商量，去调整哪些权限提权或者降权」。

### 为什么 v1 不够

v1 把 `git reset --hard` / force push 也归进了 `high`（硬拦）。对用户来说这是错的：
删 `$HOME` 是「永远不该发生」，强推自己的分支是「我授权就可以」。把两者放在同一档，
结果是要么全都拦（现状痛点），要么全都放（失去底线）。

真正的区分不是「多严重」，而是**「能不能恢复」**与**「用户授权了吗」**两件事。

### v2 改动

| 文件 | 改动 |
|---|---|
| `bridge/gates/policy.js` | 新增 `DESTRUCTIVE_CATEGORIES`（7 类）/ `DESTRUCTIVE_TIERS` / `effectiveDestructiveTier` / `machineGateConfigPath` / `applyMachineOverride`；`finding` 新增 `category`；git 类从 `high` 改为 `confirm` + 类别；`dd of=` 拆分「裸设备=红线」与「普通文件=可授权」；`no-destructive-bash` 改为「guardrail 硬拦 / permission 按档」；新增 `no-self-grant` 检查；`shouldBlock` 透传 `confirmCategory`；`normalizePolicy` 逐键合并 grants 并校验档位 |
| `bridge/gates/pi/index.js` | 确认弹窗从二选一改为 `ctx.ui.select` 三选一（允许一次 / 本会话允许这一类 / 拒绝，关闭=拒绝）；新增 `/gate` 命令（list/grant/ask/deny/reset/session）；启动时 `applyMachineOverride`；`registerCommand` 能力防御（没有该方法时只丢 `/gate`，不丢门控） |
| `bridge/gates/dsh/index.js` | 接入 `applyMachineOverride`；注释写明无 UI 通道导致 confirm 降级 |
| `bridge/gates/pi/policy.json`、`dsh/policy.json` | 新增 `destructive_grants` 表；`checks` 加 `no-self-grant`；pi 的 reminder 文案从「一律拦截」改为分层描述 |
| `bridge/lib/gates.js` | 安装 README 增加「两层 + 七个类别 + `/gate`」说明 |
| `bridge/test/gate-destructive.test.js` | 重写为两层模型：guardrail 不可授权、七个类别、收紧优先、自我提权防护、机器覆盖、pi 三选一、dsh 降级、两端配置一致 |
| `bridge/test/gate-policy.test.js` | `HARD_CHECKS` 期望集合加入 `no-self-grant` |
| `docs/ADR/012-destructive-confirm-tier.md` | 追加 v2 修订：两层模型、授权优先级、自我提权防护 |
| `tasks/CHG-20261105-destructive-confirm-tier/DESIGN.md` | 重写为两层模型 |

### v2 过程中修掉的两个真实缺陷

1. **`pi.registerCommand is not a function` 会让整个扩展加载失败**：22 个既有 adapter 测试同时变红。
   根因不是测试桩过时，而是扩展对宿主能力做了硬假设——旧版 pi 或缺少命令 API 的宿主会让门控
   **完全失效**（连安全层一起丢）。修法：能力探测后再注册，`/gate` 是增强，不是前提。
2. **`policy.json` 没显式声明 `destructive_grants`**：只有 `DEFAULT_CONFIG` 里有，用户打开配置文件
   看不到这张表，也无从修改。修法：两端 `policy.json` 都写出完整表。

### v2 基线（实测，2026-11-05）

```
node --test bridge/test/*.test.js   # EXIT=0，258 tests / 257 pass / 0 fail / 1 skipped
```
（v1 基线 222 项 → v2 258 项，新增 36 项覆盖两层模型与授权链路）
