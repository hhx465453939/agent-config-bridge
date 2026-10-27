---
change_id: CHG-20261031-gate-p2-hardening
status: approved
created: 2026-10-31
owner: pi
---

# CHG-20261031 · 门控 P2：误伤收敛与失败关闭

## 1. 目标（可判定终态）

1. **凭据检测不再误伤邮箱**：`no-secret-write` 移除「任意邮箱 = 凭据」规则，改为只在凭据赋值上下文（password/token/secret 附近）判定邮箱。正常文档、示例、联系方式不再被拦。
2. **CHG 契约可按路径收窄**：新增 `chg_contract_scope_globs`（默认 `[]` = 全部代码）。团队可把 CHG 强制范围限定到真正治理的目录，避免历史遗留 `tasks/CHG-*` 让全仓库改动都要先读契约。
3. **策略读不出来时 fail-closed**：`fallback` 不再返回空 checks，而是保留 `no-secret-write` + `no-destructive-bash` + `no-write-outside` 三项安全规则，并明确标记「degraded」，让「门控静默消失」变成「安全底线仍在」。

## 2. 独占文件

- `bridge/gates/policy.js`
- `bridge/gates/pi/index.js`
- `bridge/gates/pi/policy.json`
- `bridge/test/gate-policy.test.js`
- `bridge/test/gate-adapter.test.js`
- `docs/ADR/008-gate-fail-closed-and-false-positive.md`

## 3. 验收断言（每条都能红）

| AC | 断言 | 破坏方式 |
|---|---|---|
| AC-1 | 正文里的普通邮箱（`<your-email>` 形态）不被判为凭据 | 恢复独立邮箱正则 → 红 |
| AC-2 | `password=<opaque-value>` 仍被拦 | 删凭据上下文规则 → 红 |
| AC-3 | `password: <mailbox>` 被拦（凭据上下文里的邮箱） | 删上下文规则 → 红 |
| AC-4 | `chg_contract_scope_globs=[]` 时行为不变 | 改成默认无约束 → 红 |
| AC-5 | 配置 `['**/bridge/**']` 时，`docs/x.js` 改代码不要求 CHG，`bridge/x.js` 仍要求 | 忽略 scope → 红 |
| AC-6 | policy 读取失败时 checks 含三项安全规则，且 UI/stderr 报 degraded | 返回空 checks → 红 |
| AC-7 | degraded 状态下 `no-secret-write` 能实际拦截 | 只保留名字不实现 → 红 |
| AC-8 | 全量单测绿 + `scan-secrets.sh` 无命中 | 任一失败 |

## 4. 绝不做什么

- 不因为「邮箱误伤」就关掉整个 secret 检查。
- 不把 `chg_contract_scope_globs` 默认设成非空（不改变现有仓库语义）。
- 不在 fail-closed 时启用需要会话证据的规则（read/write 证据、CHG 契约）——那些规则在 degraded 状态下缺少可靠状态，强行启用会锁死。
- 不引入第三方依赖。

> 注：本文档最初版本用了真实形态的邮箱与口令示例，被现役门控当场拦截——这本身就是 AC-1/AC-3 所修问题的现场证据。示例现已全部占位符化。
