---
change_id: CHG-20261031-gate-format-false-positive
status: approved
version: 1
approved_by: user (standing authorization: 常驻授权，文档写完后自动开发，不再逐项确认)
approved_at: 2026-10-31
supersedes: null
---

# PRD · 承诺什么 / 不承诺什么

## 问题（现场证据，2026-10-31 本机）

`bashDestructiveFinding` 用**前缀**匹配主机级破坏性动词：

```js
if (/^(?:mkfs|fdisk|parted|diskpart|format)/.test(verb) || ...) return finding('host-level destructive command');
```

`format` 因此吞掉了 PowerShell 的整个只读输出格式化指令族。实测（真引擎，14+ case）：

| 命令 | 现行为 | 应然 |
|---|---|---|
| `Get-Acl . \| Format-Table Name,Rights` | 拦截 | 放行 |
| `Get-Acl . \| Format-List` | 拦截 | 放行 |
| `Get-ChildItem \| Format-Wide` | 拦截 | 放行 |
| `Get-Item . \| Format-Custom` | 拦截 | 放行 |
| `Get-Content -Encoding Byte \| Format-Hex` | 拦截 | 放行 |
| `formatter --help` | 拦截 | 放行 |
| `format D: /q` | 拦截 | 拦截 |
| `format` 及其 `.com` 形态（如 `format D: /q`） | 拦截 | 拦截 |
| `Format-Volume -DriveLetter D` | 拦截 | 拦截 |
| `mkfs.ext4 /dev/sdb1`、`mkfs.xfs -f` | 拦截 | 拦截 |
| `fdisk -l`、`parted /dev/sdb`、`diskpart(.exe)` | 拦截 | 拦截 |

次生伤害：判据是**整条命令文本**，所以 `agent` 连「写一条验证命令来证明这是误伤」都做不到（该验证命令本身被拦）。这与 ADR-008 记录的「误伤会训练用户关掉检查」同型，属于 P2「误伤收敛」未收干净的一处。

## 承诺

| # | 承诺 | 用户可感知的结果 |
|---|---|---|
| P-1 | PowerShell 只读输出格式化与普通 `format*` 词不再被 `no-destructive-bash` 拦 | Windows 上检查类命令不再被打回返工 |
| P-2 | 真·磁盘格式化（`format` 的裸动词与 `.com` 形态、`format D: /q`，含藏在 `cmd /c`、`bash -c` 里的嵌套形态）仍被拦 | 安全不退化 |
| P-3 | `Format-Volume`（PowerShell 里真会摧毁卷的 cmdlet）仍被拦 | 收紧不得开洞 |
| P-4 | `mkfs` 全家族（`mkfs`、`mkfs.ext4`、`mkfs.xfs`…）、`fdisk`、`parted`、`diskpart(.exe)` 仍被拦 | 收紧不得开洞 |
| P-5 | 规则只有一处判据；本机部署文件与仓库一致（`apply` 后 `diff` 为 0） | 不会「仓库修了、本机没修」 |

## 不承诺

- 不承诺命令语义级判定：门控不执行命令、不做 PowerShell AST 解析；只做动词级保守匹配。
- 不覆盖 PowerShell 全部破坏性 cmdlet（`Clear-Disk` / `Initialize-Disk` / `Remove-Partition` 等不在本次范围，另行立项）。
- 不改 bash 侧其他规则（`rm` / `git` / `dd` / `chmod` / SQL）。
- 不动 v4 的门控强度参数（证据 TTL、拦截上限、轮次级 no-slack）。
- 不为绕开误伤而开放 `destructive_allow_patterns` 宽口径（那是把整条 shell 通道的破坏性检测一起关掉）。

## 边界条件

- 判据输入是 `parseCommandHead` 产出的 `verb`：已剥离目录（`C:\Windows\System32\` 下的 `format` 命令带 `.com` 后缀时归一成同名动词）并小写化。
- 嵌套 shell（`sh|bash|zsh|dash|ksh|cmd|powershell|pwsh` + `-c|/c|/C|-Command`）沿用既有递归，深度上限 2。
- 管道（`SHELL_SEGMENT`）切段后逐段判；`| Format-Table` 是独立一段。

## 用户故事

```yaml
- id: US-001
  title: 只读输出格式化不再被当作磁盘格式化
  user: 在 Windows 上用 pi 的开发者（以及模型自身）
  outcome: 检查类 PowerShell 管道一次通过，不产生返工
  priority: 1
  dependencies: []
  acceptance_criteria: [AC-1, AC-2]
  evidence_method: [unit-test, live-probe]
  risks: [放宽过度导致真格式化漏判]
  status: approved
- id: US-002
  title: 收紧不放走真破坏
  user: 宿主机主人
  outcome: format / Format-Volume / mkfs / fdisk / parted / diskpart 仍被拦，嵌套形态也拦
  priority: 1
  dependencies: [US-001]
  acceptance_criteria: [AC-3, AC-4, AC-5]
  evidence_method: [unit-test]
  risks: []
  status: approved
- id: US-003
  title: 修完即上线且可回溯
  user: 宿主机主人
  outcome: 仓库与 ~/.pi 部署一致、0 漂移，提交历史可查，可回滚
  priority: 1
  dependencies: [US-001, US-002]
  acceptance_criteria: [AC-6, AC-7, AC-8]
  evidence_method: [diff, rollback-drill]
  risks: []
  status: approved
```

## 成功指标

| 指标 | 目标 |
|---|---|
| `Format-*` 只读指令误拦 | 0（5 个 cmdlet + `formatter` 全覆盖） |
| 真破坏性动词漏放 | 0（回归用例覆盖 11 种形态，含嵌套） |
| 全量单测 | 0 fail（基线 195 项 → 增至 198+） |
| 本机部署漂移 | 0 |

## Definition of Ready

- 现场证据齐：误伤与应拦两侧都有可复现命令；
- 根因定位到单行（`bridge/gates/policy.js:1278`），无第二处判据；
- 收紧边界（要保住哪些真破坏）已显式列出；
- 采纳边界（不扩到其他 cmdlet、不动 v4 强度）已写明。

## Definition of Done

- AC-1..AC-8 全部有可红证据；
- `node --test`、`node --check bridge/cli.js`、`bash scripts/scan-secrets.sh` 全绿；
- `bridge/cli.js apply` 后 `diff` 为 0，且部署文件实测放行/拦截与仓库一致；
- ADR-010 记录取舍；TRACEABILITY 行行有证据；
- 提交一次（`fix(gates)`），推送成功。

## 未决问题

无。范围、边界、非目标均已锁定；`Format-Volume` 属于「真破坏」一侧，已纳入 P-3。
