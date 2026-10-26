---
change_id: CHG-20261029-agent-config-bridge-gate-scope
status: approved
created: 2026-10-29
owner: pi
---

# CHG-20261029 · 门控「大小写不敏感」+「项目适用范围」

## 1. 目标（可判定终态）

修复 `chg-contract-before-edit` 的两个真实缺陷：

1. **大小写敏感导致静默失效**：`normalizePath` 会把**路径**小写化，而 `chg_contract_globs`
   未小写化。配置写 `**/tasks/CHG-*/SPEC.md`（自然写法）即永不匹配 —— 门控看起来装了，实际完全没生效。
2. **无项目适用性判断导致死锁**：不用 CHG 体系的项目（本仓库用 ADR 管理变更）
   一旦门控生效就**再也改不了任何代码**，连修门控自身都被拦。

终态：配置写大写能生效；不用 CHG 的仓库不被拦；用 CHG 的仓库仍强制读契约。

## 2. 独占文件

- `bridge/gates/policy.js`（`isChgContract` + `chg-contract-before-edit` + `DEFAULT_CONFIG`）
- `bridge/gates/pi/policy.json`（globs 改回自然大写）
- `bridge/test/gate-policy.test.js`（新增用例）
- `docs/ADR/005-gate-case-insensitive-and-project-scope.md`

## 3. 验收断言（每条都能红）

| AC | 断言 | 破坏方式 |
|---|---|---|
| AC-1 | `isChgContract('tasks/CHG-X/SPEC.md')` 与配置里大写 glob 匹配 | 去掉 `.toLowerCase()` → 红 |
| AC-2 | 路径与 glob 大小写混写（`Tasks/Chg-X/Spec.md`）仍匹配 | 只对一侧小写化 → 红 |
| AC-3 | 仓库无 `tasks/` → 不拦 | 删掉 `exists(tasksDir)` 判断 → 红 |
| AC-4 | `tasks/` 存在但无 `CHG-*` 子目录 → 不拦 | 删掉 `listDir` 判断 → 红 |
| AC-5 | `tasks/CHG-*/` 存在且未读契约 → 仍拦 | 把 check 直接 return null → 红 |

## 4. 绝不做什么

- **不放松**「读过 CHG 契约才放行」的核心语义（AC-5 守着）。
- 不引入第三方依赖（CONTRIBUTING：零依赖）。
- 不改 `HARD_CHECKS` 构成（仍是硬检查）。
- 不因为「修不动」就把 `require_chg_contract` 默认设为 false。
