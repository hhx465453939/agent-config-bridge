# ADR-005 · 门控契约检查的两个必要修正：大小写归一 + 项目适用范围

- 状态：accepted
- 日期：2026-10-29
- 相关：ADR-004（ai-spec 契约门控）

## 背景

ADR-004 引入 `chg-contract-before-edit` 后，实测在数小时内暴露两个缺陷。

### 缺陷 1：大小写导致静默失效

`normalizePath` 会把路径小写化（Windows 下还转反斜杠），而 `matchesAnyGlob` 不做大小写归一。
首版因此要求 `chg_contract_globs` **必须全小写**。

后果：配置写成自然的大写形态（`tasks/CHG-<id>/SPEC.md` 那类 glob）时，门控**永不触发**。
这是最危险的失效形态——看起来有保护，实际没有，且不报错。

**判定：这不是配置问题，是代码缺陷。程序应适配输入，不应要求人手写小写。**

### 缺陷 2：无项目适用范围，导致死锁

本仓库用 ADR 管理变更，没有 `tasks/CHG-*/`。门控生效后：

- 改任何代码 → 要求先读 CHG 契约
- 本仓库不存在该文件 → 永远无法满足
- 连**修门控自身**都被拦截

实测：修 `policy.js` 时被自己的门控拦下两次（先缺 CHG 契约，补契约后又缺约定文档）。

**判定：门控必须先判断「本项目是否采纳 CHG 体系」，否则会砖化所有非 CHG 仓库。**

## 决策

| # | 决策 | 实现 |
|---|---|---|
| D-1 | `isChgContract` 对**路径与 glob 两侧**统一小写化 | `globs.map(g => String(g).toLowerCase())` |
| D-2 | 配置可写自然大写，作为回归证据 | `DEFAULT_CONFIG` 与 `policy.json` 的 globs 改回大写 |
| D-3 | 项目适用性由**文件系统事实**判定 | `tasks/` 存在 且 含 `CHG-*` 子目录 |
| D-4 | 不采纳 CHG 的项目直接跳过该 check | `return null` |
| D-5 | 「读契约才放行」的核心语义不放松 | 对应用例守着（有 `CHG-*/` 未读仍拦） |

## 后果

**正向**

- 大写 / 小写 / 混写配置行为一致，消除「必须记着小写」这类隐性知识。
- 非 CHG 仓库（本仓库、`Claude_skill_pool` 等）恢复正常改代码。
- CHG 仓库（如 `xuanji-brain`）的保护不退化。

**代价**

- 多一次 `exists` + `listDir` 探测（O(1)，可忽略）。
- `listDir` 读取失败（权限）时视为「不采纳 CHG」→ 宁可漏拦，不可死锁。
- 判定依赖目录命名约定 `tasks/CHG-*`；若某项目改用其他目录需同步修改。

## 验证

```
node --test                          → 169 tests, 167 pass, 0 fail, 2 skipped
node --check bridge/gates/policy.js  → OK
bash scripts/scan-secrets.sh         → OK: no sensitive content found
```

**断言能红（已实测，非推断）**：

1. 去掉 `toLowerCase()` → 「glob 大小写不敏感」用例红。
2. 注释掉项目适用性判断 → 「不用 CHG 体系的仓库不被拦」用例红。
