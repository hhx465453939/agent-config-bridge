---
change_id: CHG-20261124-ci-glob-case-fixture
version: 1
status: approved
created: 2026-11-24
owner: Owner
---

# TRACEABILITY-20261124 · CI glob 大小写用例

| 需求 | 实现位置 | 验证方式 |
|---|---|---|
| AC-1 用例通过 | `bridge/test/gate-policy.test.js` 的 glob 大小写用例 | `node --test bridge/test/gate-policy.test.js` |
| AC-2 目录由 CHG_DIR 派生 | 同上，`recordDocRead(..., join(CHG_DIR, ...))` | 代码审阅 + 本地测试 |
| AC-3 无回归 | 全仓库 | `node --check` + `node --test` + `scan-secrets.sh --history` |
| AC-4 三平台转绿 | CI 矩阵 | `gh run watch` / `gh run list` |

## 平台语义说明

Windows 的 `normalizePath` 会整体小写化，POSIX 不会。fixture 若依赖「换目录名的大小写
仍能命中」，就只在 Windows 成立。修复把大小写变化限制在文件名上，目录一律取自
`CHG_DIR`，从而与平台无关。
