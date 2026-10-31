---
change_id: CHG-20261031-gate-format-false-positive
version: 1
status: approved
created: 2026-10-31
owner: pi
prd_ref: PRD.md
health_ref: null   # 本仓库按 CHG 立约，无独立 HEALTH 基线（仅 CHG-001 有）
supersedes: null
approved_by: user (standing authorization)
approved_at: 2026-10-31
---

# CHG-20261031 · 门控 P2 补丁：`format` 前缀匹配误伤 PowerShell `Format-*`

## 1. 背景 / 目标 / 非目标

**背景**：`bashDestructiveFinding` 的主机级破坏性动词判据混用了两种语义：

- `mkfs` 家族与 `diskpart.exe` **需要**前缀匹配（`mkfs.ext4`、`mkfs.xfs`、`diskpart.exe` 都是同一程序的变体）；
- `format` 在 bash/CMD 世界是**裸动词**（`format D: /q`），但在 PowerShell 里 `format` 是一个**只读输出格式化指令族的前缀**（`Format-Table/List/Wide/Custom/Hex`）。

把 `format` 归进前缀族后，任何 `| Format-Table` 检查管道都被判成「host-level destructive command」。

**目标（可判定终态）**：

1. 只读 `Format-*` 与普通 `format*` 词放行；
2. 真·格式化（`format`、`format.com`、`format D: /q`、嵌套 `cmd /c "format D: /q"`）仍拦；
3. `Format-Volume` 仍拦（收紧不得开洞）；
4. `mkfs` 全家族 / `fdisk` / `parted` / `diskpart(.exe)` 仍拦（回归不得放宽）；
5. 仓库改了，本机 `~/.pi` 部署同步（`apply` 后 `diff` 0）。

**非目标**：PowerShell 其他破坏性 cmdlet（`Clear-Disk`/`Initialize-Disk`/`Remove-Partition`）、命令语义解析、AST、`destructive_allow_patterns` 宽口径、v4 强度参数、bash 侧其他规则。

## 2. 现状与债

- 判据**只有一处**：`bridge/gates/policy.js:1278`（`grep 'mkfs|diskpart|host-level'` 全仓库仅命中此文件两行）。无第二判据、无测试守护 → 这是「无测试的保守规则」典型债：规则本身是安全网，但缺少两侧回归用例，导致误伤无人发现。
- 判据输入 `verb` 由 `commandBase` 产出：正则 `^.*[\\/]` 剥离目录 + `toLowerCase()`（policy.js:869）。因此**整体相等**匹配对带路径调用同样有效（`C:\Windows\System32\format.com` → `format.com`）。
- 嵌套 shell 与管道切段已由既有代码处理（`bashDestructiveFinding` 的 `powershell|cmd|bash…` 分支 + `SHELL_SEGMENT`），本次**复用**，不新增解析器。

## 3. 选定设计与取舍（ADR-010）

| 方案 | 做法 | 判定 |
|---|---|---|
| A 前缀匹配（现状） | `/^format/` | ❌ 误伤只读 cmdlet 族，且堵住验证命令本身 |
| B 改整体相等 + 显式补 `format-volume` | `/^…|format(?:\.(?:com|exe))?|format-volume$/` | ✅ 采纳 |
| C 精确匹配 + `destructive_allow_patterns` 放行 `Format-*` | 仓库不改正则，机器加白名单 | ❌ allow 是**整条命令**的前置放行，一条命令里同时出现 `Format-Table` 和 `format D:` 会连真格式化一起放过；且把「误伤」变成「永久配置债」 |
| D 引入 PowerShell AST / 词法器 | 大改 | ❌ 门控零依赖、不执行命令；成本远超收益 |

**取舍**：`mkfs` 保留后缀族匹配（`mkfs(?:\.[a-z0-9]+)?`），`format` 降为整体相等并额外点名 `format-volume`。代价：若将来 PowerShell 再出现新的破坏性 `Format-*` cmdlet，需显式加名（这是**有意的 fail-closed 方向**：只读族默认放行，破坏性的显式列出）。可逆性：改回单行正则即可，无数据迁移。

## 4. 接口 / 兼容 / 回滚

- **接口**：`bashDestructiveFinding(command, {config, cwd, isFile, exists}, depth)` 签名不变；返回 `{why, segment}` 或 `null` 不变。`powershellDestructiveFinding` 首行委派关系不变。
- **兼容**：`verb` 来源不变；`destructive_allow_patterns` 语义不变；dsh 适配层无感（同引擎）。
- **回滚**：`git revert` 单提交 + `node bridge/cli.js apply`；或 `node bridge/cli.js rollback`（本机）。无 DB / 无迁移。
- **安全**：不新增外部输入面；不放宽任何**安全**规则（凭据写入、越界写入仍 fail-closed）。

## 5. 里程碑

| MS | 内容 | 文件 | 验收 | 风险 | 回滚 |
|---|---|---|---|---|---|
| M1 | 规则收紧 + 两侧回归用例 | `bridge/gates/policy.js`、`bridge/test/gate-v4.test.js` | AC-1..AC-5 | 收紧过度 | 单提交 revert |
| M2 | 全量验证 | — | `node --test` 0 fail、`node --check`、`scan-secrets.sh` | 无 | — |
| M3 | 本机上线 | `~/.pi/agent/extensions/enforce-rules/policy.js` | `apply` 后 `diff` 0；部署文件实测 | 部署漂移 | `bridge/cli.js rollback` |
| M4 | 交付 | ADR-010、CHANGE、TRACEABILITY、提交推送 | AC-6..AC-8 | 提交夹带无关产物 | 显式文件清单，禁 `git add .` |

依赖：M1 → M2 → M3 → M4，严格串行。

## 6. 验收断言（每条都能红）

| AC | 断言 | 破坏方式（先让它红） |
|---|---|---|
| AC-1 | `Format-Table/List/Wide/Custom/Hex` 五种只读指令不被 `powershellDestructiveFinding` 判破坏 | 恢复 `/^format/` → 红 |
| AC-2 | `formatter --help` 不被判破坏 | 恢复前缀匹配 → 红 |
| AC-3 | `format D: /q`、`format.com C:`、`cmd /c "format D: /q"` 仍判破坏 | 把 `format` 从动词表删掉 → 红 |
| AC-4 | `Format-Volume -DriveLetter D` 仍判破坏 | 正则里去掉 `format-volume` → 红 |
| AC-5 | `mkfs`、`mkfs.ext4`、`mkfs.xfs`、`fdisk -l`、`parted …`、`diskpart`、`diskpart.exe` 仍判破坏 | 改成 `/^mkfs$/` 之类过紧 → 红 |
| AC-6 | `node --test` 全绿、`node --check bridge/cli.js` 通过、`scan-secrets.sh` 无命中 | 任一失败 |
| AC-7 | `bridge/cli.js apply` 后 `diff` 为 0（仓库=部署） | 只改仓库不 apply → 红 |
| AC-8 | 部署后的 `~/.pi/.../policy.js` 实测：`Format-Table` 放行、`format D: /q` 拦截 | 部署文件仍是旧正则 → 红 |

## 7. DoR / DoD

**DoR**：PRD 已批准（standing authorization）；根因单点确认；两侧边界显式；测试可离线运行（`policy.js` 零依赖、可注入 fs）。

**DoD**：AC-1..AC-8 全绿且有证据；ADR-010 落地；TRACEABILITY 行行有证据；提交一次（`fix(gates)`）、远程推送成功；无残留 TODO。

## 8. 评审与交付门

| 门 | 判据 | 本次授权 |
|---|---|---|
| PRD_APPROVED | 用户批准 | standing authorization（2026-10-31） |
| SPEC_APPROVED | 用户批准版本 v1 | 同上 |
| COMMIT | 显式文件清单 + `scan-secrets.sh` 通过 | 同上 |
| PUSH | 提交后推 `origin main` | 同上 |
