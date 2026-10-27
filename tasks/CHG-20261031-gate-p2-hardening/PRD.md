---
change_id: CHG-20261031-gate-p2-hardening
status: approved
---

# PRD · 承诺什么 / 不承诺什么

## 承诺

| # | 承诺 | 用户可感知的结果 |
|---|---|---|
| P-1 | 写 README / 文档里的普通邮箱不再被门控拦 | 少一类无意义返工 |
| P-2 | 真正的凭据赋值（含邮箱形态）仍被拦 | 安全不退化 |
| P-3 | CHG 契约可以按目录收窄 | 历史 CHG 不再拖累全仓库 |
| P-4 | 策略文件坏掉时，安全底线仍在并明确告警 | 不会「以为在管、其实没管」 |

## 不承诺

- 不承诺邮箱检测达到语义级准确；它只覆盖「凭据字段附近出现邮箱」这一种高风险组合。
- 不承诺自动迁移旧配置；`chg_contract_scope_globs` 缺省即旧行为。
- 不承诺 degraded 状态下提供完整门控；它是安全底线，不是完整规则。

## 边界条件

- 凭据上下文窗口：邮箱前后 40 个字符内出现 `password|passwd|secret|token|api[_-]?key|credential` 才判定。
- `chg_contract_scope_globs` 与 `isCodeFile` 同时成立才要求契约。
- fail-closed 的三项检查都不依赖 `state` 证据，只依赖文件系统与命令文本。
