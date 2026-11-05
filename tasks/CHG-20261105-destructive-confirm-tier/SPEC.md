---
change_id: CHG-20261105-destructive-confirm-tier
version: 1
status: approved
prd_ref: PRD.md
created: 2026-11-05
owner: pi
---

# SPEC-20261105 · 破坏性命令的三档分级（high / confirm / allow）

## 1. 目标（可判定终态）

1. **finding 带严重度**：`bashDestructiveFinding()` / `powershellDestructiveFinding()` 返回的每个 finding 都有
   `severity: 'high' | 'confirm'`，不再只有「有 finding / 没 finding」两种信息。
2. **allow 档不产生 finding**：可丢弃目标（`node_modules` / `dist` / `build` / `.venv` / `tmp` 等路径段）依旧返回 `null`，
   `rm -rf node_modules` 行为与改动前逐字一致。
3. **guardrail 红线硬拦**：`no-destructive-bash` 对 `severity === 'high'` 返回 `DESTRUCTIVE_BASH`。
   这一档**不可授权**：删 `$HOME`/cwd/含 `..`/顶层目录/git 仓库根、磁盘格式化、裸设备写入、关机重启。
   即使把全部七个类别都设为 `allow`，红线依旧拦。
4. **permission 按类别分级**：`severity === 'confirm'` 的 finding 带 `category`，
   由 `effectiveDestructiveTier(category, config, state)` 决定 `allow` / `confirm` / `deny`：
   - `allow` → `return null`（用户已授权，直接执行，不弹窗、不计数）
   - `deny` → `DESTRUCTIVE_DENIED` 硬拦，并在文案里给出 `/gate ask|grant <类别>` 的回头路
   - `confirm` → 带 `confirm: true` 的判定，**不计入 block cap**、不置 `block: true`
5. **pi 端真弹窗**：`bridge/gates/pi/index.js` 的 bash 分支遇到 `confirm` 判定时，
   在 `ctx.hasUI` 且 `ctx.ui.confirm` 可用时 `await ctx.ui.confirm(...)`；
   用户拒绝 → `{ block: true, reason }`；用户允许 → 继续原有记录逻辑。
6. **pi 非交互不卡死**：`ctx.hasUI` 为假时 confirm 档放行，并向 stderr 写一行
   `[enforce-rules] DESTRUCTIVE_CONFIRM auto-approved (no UI): <command>`。
7. **dsh 端降级**：`bridge/gates/dsh/index.js` 的 bash 分支遇到 `confirm` 判定时 `return next()`；
   `high` 仍 `{ kind: 'deny' }`。代码注释与 ADR-012 必须写明这是端能力差异。
8. **开关可回退**：`policy.config.destructive_confirm_mode` 默认 `true`；显式 `false` 时
   confirm 档回到 `DESTRUCTIVE_BASH` 硬拦（等价于改动前行为）。
9. **两端 policy.json 同步**：`bridge/gates/pi/policy.json` 与 `bridge/gates/dsh/policy.json` 都声明
   `destructive_confirm_mode: true`。
10. **安装目录说明同步**：`bridge/lib/gates.js` 生成的 README 增加「破坏性命令三档」一节。

## 2. 架构与债务

- 延续 ADR-003 的分层：**策略层判定严重度，适配层决定「能不能问」**。
  `policy.js` 只产出 `severity` 与 `confirm` 标记，不 import 任何 UI；adapter 才碰 `ctx.ui`。
- `shouldBlock` 的签名不变（`{policy, input, state, fs, now}`），返回对象新增两个字段
  `confirm: boolean` 与 `confirmReason: string|null`。既有调用方不读这两个字段也不会坏。
- 已知债务（不在本 CHG 修）：`policy.js` 已约 2870 行、`parseBashCommand` 复杂度高。
  本 CHG 只新增一个纯函数 `unrecoverableTarget()` 与少量分支，不重构既有解析器。
- 已知债务：`isDisposablePath` 把 `tmp` / `temp` 当可丢弃段，因此 `/tmp/<任意>` 仍是 allow 档。
  这是既有行为，本次不动（N-3），但要在 ADR-012 记录「`/tmp` 的顶层目录本身是 high」这一边界。

## 3. 选定设计与 ADR

- ADR：`docs/ADR/012-destructive-confirm-tier.md`。
- 判定「不可恢复」用**纯函数** `unrecoverableTarget(raw, cwd)`，判据只有路径形状与环境变量：
  1. 原始 token 含 `..` 段 → high（归一化会消掉 `..`，必须在归一化**之前**判）
  2. 解析后是 `/` 或盘符根 → high
  3. 解析后路径段数 ≤ 1（`/tmp`、`/usr`、`/home` 这类顶层目录）→ high
  4. 等于 `$HOME` 或是 `$HOME` 的祖先 → high
  5. 等于 cwd 或是 cwd 的祖先 → high（删祖先会连带删掉 cwd）
  6. 解析不了（`$VAR` 等）→ 不判 high（不猜测），落到 confirm
- 破坏历史/未提交工作的 git 子命令（`reset --hard`、`clean -f`、`checkout -- .`、`restore`、
  `push --force`、`branch -D`、`filter-branch`/`filter-repo`、`stash drop|clear`）→ 一律 high。
- 主机级/磁盘级/数据库级（`mkfs*`、`fdisk`、`parted`、`diskpart`、`format`、`format-volume`、
  `shutdown`/`reboot`/`poweroff`/`halt`、`init 0|6`、`Stop-Computer`、`taskkill /F`、
  `dd of=<非 /dev/null>`、`DROP TABLE|DATABASE|SCHEMA`、`TRUNCATE TABLE`）→ 一律 high。
- 「删除具体目标」类（`rm`/`rmdir`/`unlink`、`del`/`erase`、`rd /s`、`Remove-Item -Recurse`、
  `clear-content`、`find -delete`、`chmod/chown/chgrp -R`）→ 由 `unrecoverableTarget(目标)` 决定 high 还是 confirm。
- 可选注入 `isGitRepo(dir)`：用于把「`rm -rf` 一个不在 cwd 祖先链上的 git 仓库根」判为 high。
  默认 `null` 表示不探测，保持 `policy.js` 的 disk-free 可测性；adapter 传入基于 `realFs.exists` 的实现。

## 4. 接口与配置

```js
// policy.js（导出签名变化：opts 新增 isGitRepo）
bashDestructiveFinding(command, { config, cwd, isGitRepo = null }, depth) 
  -> { why: string, segment: string, severity: 'high'|'confirm' } | null

powershellDestructiveFinding(command, { config, cwd, isGitRepo = null })
  -> 同上

shellDestructiveFinding(input, { config, cwd, isGitRepo })
  -> 同上

shouldBlock({ policy, input, state, fs, now })
  -> { block: boolean, code: string|null, reason: string|null, capReached: boolean,
       confirm: boolean, confirmReason: string|null }
```

`policy.json` 新增（pi 与 dsh 各一份）：

```json
{
  "config": {
    "destructive_confirm_mode": true
  }
}
```

`DEFAULT_CONFIG` 新增同名键，默认 `true`。

## 5. 安全脱敏

- 本 CHG 全部文件不得出现家目录绝对路径、主机名、端口、邮箱、凭据。
  测试里的 HOME 用 `os.homedir()` 运行时推导，文档里写 `$HOME` / `<home>`。
- 确认弹窗只展示 `finding.why` 与截断到 200 字符的命令片段（既有 `segment` 已是 200 上限），
  不展示文件内容。
- stderr 那行日志同样只写截断后的命令。

## 6. 绝不做什么

- 不把 `no-destructive-bash` 从 `HARD_CHECKS` 移出（N-4）。
- 不让 `confirm` 档消耗 `state.blocks`（否则几次删除就花光会话的规则预算）。
- 不在 `policy.js` 里 import UI / 读磁盘（`isGitRepo` 只能注入，不能内置 fs 调用）。
- 不改 `isDisposablePath` 的既有判据与 `destructive_disposable_segments` 默认值。
- 不给 confirm 档加「本次会话不再询问」的持久化（N-2）。
- 不为了「测过」而只测函数、不测 adapter 分支（AC-11 / AC-12 必须覆盖 adapter）。
- 不 `git add .`。

## 7. 里程碑

| 里程碑 | 内容 | 完成判据 |
|---|---|---|
| M0 | `policy.js`：`unrecoverableTarget` + finding 加 `severity` + `no-destructive-bash` 分级 + `shouldBlock` 透传 | AC-1…AC-10 绿 |
| M1 | `pi/index.js` 弹窗 + 非交互降级；`dsh/index.js` 降级 | AC-11、AC-12 绿 |
| M2 | 两端 `policy.json` + `DEFAULT_CONFIG` + `gates.js` README | AC-9（配置）、AC-13 绿 |
| M3 | ADR-012、DESIGN、TRACEABILITY 实测证据 | AC-14 绿 + 部署核对 |

## 8. 验收断言（每条都能红）

| AC | 断言 | 破坏方式 |
|---|---|---|
| AC-1 | `bashDestructiveFinding('rm -f <cwd>/scratch.txt')` 返回 `severity === 'confirm'`；`shouldBlock` 的 `block === false` 且 `confirm === true` | 让普通删除仍返回 high → 红 |
| AC-2 | `rm -rf $HOME`（运行时 `os.homedir()`）→ `severity === 'high'` 且 `shouldBlock.block === true`，`code === 'DESTRUCTIVE_BASH'` | 放宽 HOME 判定 → 红 |
| AC-3 | `rm -rf .` → high + block | 去掉 cwd 判定 → 红 |
| AC-4 | `git reset --hard` → `severity='confirm'`、`category='git-history'`；`/gate grant git-history` 后不弹窗；`/gate deny git-history` 后 `DESTRUCTIVE_DENIED` | 把 git 归到 guardrail（不可授权）→ 红 |
| AC-5 | `git push --force` / `-f` / `--force-with-lease` → `category='git-force-push'`（与 `git-history` 分开） | 并进 git-history → 红 |
| AC-6 | `rm -rf node_modules` → finding 为 `null`（allow 档不回归） | 把 disposable 判据删掉 → 红 |
| AC-7 | `rm -rf <abs>/xx/../..` → high + block（含 `..`） | 只按归一化后判定 → 红（归一化后是 `/`，仍 high，故另测 `rm -rf data/../..` 的 token 判定） |
| AC-8 | `destructive_confirm_mode: false` 时同一 confirm 命令 → `block === true`，`code === 'DESTRUCTIVE_BASH'` | 忽略开关 → 红 |
| AC-9 | confirm 判定前后 `state.blocks` 不变（不消耗 block cap）；且 `HARD_CHECKS.has('no-destructive-bash')` 仍为真 | 让 confirm 计数 → 红 |
| AC-10 | `rm -rf /tmp`、`rm -rf /usr` → high（顶层目录）；`rm -f /tmp/x.txt` → 不 block（tmp 段可丢弃） | 去掉段数判定 → 红 |
| AC-11 | pi adapter：`hasUI` 为真且 confirm 返回 `false` → `{ block: true }`；返回 `true` → 不 block；`hasUI` 为假 → 不 block 且 stderr 有一行 | 直接把 confirm 当放行 → 红 |
| AC-12 | dsh adapter：confirm 档 → `next()`；high 档 → `{ kind: 'deny' }` | 只改 pi → 红 |
| AC-13 | `bridge/gates/pi/policy.json` 与 `bridge/gates/dsh/policy.json` 均含 `destructive_confirm_mode: true`；`planGateInstall` 生成的 README 含「破坏性命令」三档说明 | 只改一端 → 红 |
| AC-14 | `node --test bridge/test/*.test.js` 全绿；`bash scripts/scan-secrets.sh` 无命中；`node bridge/cli.js apply --targets pi` 后安装副本 `policy.json` 含新键 | 任一失败 |

## 9. Definition of Ready

- PRD 已与用户口头对齐：用户原话「和用户确认以后才能删」「全自动授权给你核查代码写计划执行开发测试commitpush上线部署」。
- 基线已实测：`node --test bridge/test/*.test.js` → **EXIT=0，222 tests / 221 pass / 0 fail / 1 skipped**。
- 三个事实前提已核实（PRD 末节）：pi 原生不弹确认、pi 扩展有 `ctx.ui.confirm`、dsh 无 UI 通道。
- 源头已定位：`bridge/gates/policy.js` 与安装副本 `~/.pi/agent/extensions/enforce-rules/policy.js`
  sha256 一致（同一次 apply 产物），改源头 + `apply` 即部署。

## 10. Definition of Done

- AC-1…AC-14 全部有实测证据写入 `TRACEABILITY.md`。
- 策略层、两个 adapter、两个 policy.json、安装器 README、ADR、DESIGN 齐头并进落地。
- `apply` 到本机后用安装副本实测一次真实删除（`rm -f` 一个临时文件）通过。
- 提交按「策略层 + 适配层 + 配置/文档」拆分，显式列文件，脱敏扫描干净。

---

## 11. v2 扩展（用户追加需求）：可协商的权限分层

> 用户原话：「不仅仅是删除，还有 git push force 这种，其实应该给这个破坏性功能整体逻辑分层，
> 有些经过用户授权可以执行，有些坚决不行，并且随时可以和 agent 商量，去调整哪些权限提权或者降权」。

### 11.1 两层模型（取代 §1 的三档描述）

| 层 | 含义 | 可否授权 |
|---|---|---|
| **guardrail** | 删掉不可恢复：`$HOME` 及祖先、cwd 及祖先、`..` 逃逸、顶层目录、git 仓库根、磁盘格式化、裸设备写入、关机重启 | **不可**，任何 grant 无效 |
| **permission** | 严重但可恢复，按七个类别分档 | **可**，用户亲手调整 |

七个类别：`delete` / `git-history` / `git-force-push` / `db-ddl` / `perm-recursive` /
`process-kill` / `raw-write`。默认档：除 `db-ddl: deny` 外均为 `confirm`。

### 11.2 授权优先级（收紧赢过放松）

```
policy deny → deny    （永久拒绝，会话授权不能翻案）
session deny → deny   （会话可以比 policy 更严格）
session allow → allow （弹窗选的「本会话允许这一类」）
policy allow → allow  （/gate grant 的持久授权）
默认 → confirm
```

### 11.3 授权只能用户亲手给（安全边界）

- 交互弹窗三选一：`允许这一次` / `本会话允许这一类` / `拒绝`
- `/gate` 命令：`list` / `grant <类别>` / `ask <类别>` / `deny <类别>` / `reset <类别>` / `session <类别>`
- **`no-self-grant` 检查**：`write` 或 bash 写 `gate-policy.json` / 安装版 `policy.json` 且内容含
  `destructive_grants` → `GATE_SELF_GRANT` 硬拦。理由：agent 能改授权表，所有分级都是装饰。
  该检查列入 `HARD_CHECKS`（不受 block cap 影响）。

### 11.4 持久授权落点

`~/.config/agent-config-bridge/gate-policy.json`（bridge 已有的机器本地 override 源，
`apply` 不会覆盖它）。adapter 启动时调 `applyMachineOverride()`，让 `/gate` 的改动立即生效。

### 11.5 新增接口

```js
DESTRUCTIVE_CATEGORIES                       // 类别 → 中文说明
effectiveDestructiveTier(category, config, state) -> 'allow'|'confirm'|'deny'
machineGateConfigPath(home?)                  -> string|null
applyMachineOverride(policy, home?)           -> policy（config 合并 + grants 逐键合并）
```

`shouldBlock` 返回对象新增 `confirmCategory`。`bashDestructiveFinding` 的 finding 新增 `category`。

### 11.6 v2 验收断言

| AC | 断言 | 破坏方式 |
|---|---|---|
| AC-15 | 七个类别都设为 `allow` 时，`rm -rf $HOME` 仍 `block=true` | 让 guardrail 也走 tier 判定 → 红 |
| AC-16 | `db-ddl` 默认 `deny`：`drop database` → `DESTRUCTIVE_DENIED`；`/gate grant db-ddl` 后放行 | 默认改 confirm → 红 |
| AC-17 | 收紧优先：policy `deny` + session `allow` → `deny` | 让 session allow 覆盖 policy deny → 红 |
| AC-18 | `no-self-grant`：写授权表含 `destructive_grants` → `GATE_SELF_GRANT`；改同文件其它字段 → 放行 | 去掉检查 → 红 |
| AC-19 | `applyMachineOverride` 读机器文件生效，未知类别/非法档位被忽略，坏 JSON 不推翻原策略 | 整体替换 grants → 红 |
| AC-20 | pi 弹窗三选一：允许一次 / 本会话允许（后续同类不再问）/ 拒绝 / 关闭弹窗=拒绝 | 只做二选一 → 红 |
| AC-21 | `/gate grant` 写机器文件且拒绝未知类别；`/gate list` 列出全部类别与红线 | 不校验类别 → 红 |
| AC-22 | 宿主没有 `registerCommand` 时，门控仍正常执行（只丢 `/gate`，不丢安全层） | 不防御直接调用 → 红 |
