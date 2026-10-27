---
change_id: CHG-20261031-gate-p2-hardening
delivery_status: delivered
generated_by: manual
---

# TRACEABILITY · AC → 证据（实测）

| AC | 实现位置 | 证据 | 破坏方式 |
|---|---|---|---|
| AC-1 | `policy.js::scanForSecrets` | `gate-v4.test.js`「a bare mailbox is prose...」通过 | 恢复独立邮箱正则 |
| AC-2 | 同上 | 同用例凭据赋值分支通过 | 删凭据规则 |
| AC-3 | 同上 | 同用例「凭据上下文中的邮箱」分支通过 | 删上下文规则 |
| AC-4 | `chg-contract-before-edit` + `chg_contract_scope_globs` | 默认 `[]` 时既有 CHG 用例全部通过 | 默认加 scope |
| AC-5 | 同上 | 「scope globs narrow which paths need a contract」通过 | 忽略 scope |
| AC-6 | `pi/index.js::fallback` | `gate-adapter.test.js`「an unreadable policy still enforces safety rules」通过 | 返回空 checks |
| AC-7 | 同上 + `shouldBlock`/`HARD_CHECKS` | 同用例断言私钥写入被 `SECRET_WRITE` 拦截 | 只留名字 |
| AC-8 | — | `node --test` 195/193；`scan-secrets.sh --all` OK | 任一失败 |

## 现场证据

- 本轮立项文档最初含真实形态的邮箱/口令示例，被现役 v3 门控当场拦截两次；修复后工作区扫描不再命中。
- 误伤收敛只移除「裸邮箱」规则，凭据赋值与凭据上下文中的邮箱仍然拦截（AC-2/AC-3 守着）。
