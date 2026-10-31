---
change_id: CHG-20261031-gate-format-false-positive
status: delivered
---

# TRACEABILITY · 需求 → 断言 → 证据

| PRD 承诺 | 故事 | AC | 测试 / 证据 | 证据命令 | 状态 |
|---|---|---|---|---|---|
| P-1 只读 `Format-*` 放行 | US-001 | AC-1 | `gate-v4.test.js` · "read-only PowerShell Format-* cmdlets are not disk formatting" | `node --test bridge/test/gate-v4.test.js` | ✅ |
| P-1 普通 `format*` 词放行 | US-001 | AC-2 | 同上 · `formatter --help` 断言 | 同上 | ✅ |
| P-2 真格式化仍拦（含嵌套） | US-002 | AC-3 | 同上 · "real disk formatting is still blocked"（`format` 裸动词与 `.com` 形态 / `cmd /c "format D:"`） | 同上 | ✅ |
| P-3 `Format-Volume` 仍拦 | US-002 | AC-4 | 同上 · `Format-Volume -DriveLetter D` 断言 | 同上 | ✅ |
| P-4 `mkfs` 家族/分区工具仍拦 | US-002 | AC-5 | 同上 · "mkfs family and partitioning tools still blocked" | 同上 | ✅ |
| — 全量不回归 | US-003 | AC-6 | `node --test`（全仓）、`node --check bridge/cli.js`、`scan-secrets.sh` | 三条命令 | ✅ |
| P-5 仓库=部署 | US-003 | AC-7 | `bridge/cli.js apply` → `diff` 0 | `node bridge/cli.js diff` | ✅ |
| P-5 部署文件实测 | US-003 | AC-8 | 对 `~/.pi/agent/extensions/enforce-rules/policy.js` 跑正/反例探针 | `node <probe>.mjs` | ✅ |

## 现场证据（开工前，证明 AC-1/AC-3 都真能红）

用真引擎跑 18 个 case，误伤侧 6 条全红、应拦侧 11 条全绿（详见 PRD「问题」表）。修复后同一探针对部署文件复跑，逐条翻绿且真破坏仍拦。

## 证据落点

| 类型 | 位置 |
|---|---|
| 单测 | `bridge/test/gate-v4.test.js`（新增 3 个 test，覆盖 AC-1..AC-5） |
| 全量 | `node --test`（仓库根） |
| 部署一致 | `bridge/cli.js diff` = `no changes` |
| 取舍记录 | `docs/ADR/010-gate-destructive-verb-matching.md` |
