---
change_id: CHG-20261029-agent-config-bridge-gate-scope
delivery_status: in-progress
generated_by: manual
---

# TRACEABILITY · AC → 证据

> 每条 AC 都必须能红：写清破坏方式，才能证明断言真的守着行为。

| AC | 断言 | 实现位置 | 证据 | 破坏方式 |
|---|---|---|---|---|
| AC-1 | 大写 glob 能匹配 | `policy.js::isChgContract` | `test/gate-policy.test.js` 用例「大写 glob 生效」 | 去掉 `.toLowerCase()` |
| AC-2 | 双侧大小写混写能匹配 | 同上 | 同文件，路径与 glob 均混写 | 只对一侧小写化 |
| AC-3 | 无 `tasks/` → 不拦 | `policy.js::chg-contract-before-edit` | 用例「无 tasks 目录不拦」 | 删 `exists(tasksDir)` |
| AC-4 | 有 `tasks/` 无 `CHG-*` → 不拦 | 同上（`listDir`） | 用例「有 tasks 但无 CHG 子目录不拦」 | 删 `listDir` 判断 |
| AC-5 | 有 `CHG-*/` 未读 → 仍拦 | 同上 | 已有用例「改代码前未读 CHG 契约则拦」 | 直接把 check 改成 `return null` |
| AC-6 | 全量单测绿 | — | `node --test` 输出 | 任一用例失败 |
| AC-7 | 无敏感值 | — | `bash scripts/scan-secrets.sh` 输出 | 引入真实 IP / 路径 |

## 交付时需替换

- 本文件在 `--apply` 后由实测输出替换「证据」列为命令与结果摘要。
