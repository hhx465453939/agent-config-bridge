---
change_id: CHG-20261031-gate-p2-hardening
status: delivered
---

# CHANGE · 改了什么、为什么

## 根因

1. `SECRET_PATTERNS` 里独立邮箱正则会把任何邮箱形态一律判成凭据，写文档时频繁误伤（本轮立项文档就被自己的门控拦了两次）。
2. `chg-contract-before-edit` 只按「仓库有 `tasks/CHG-*`」判断是否采纳 CHG 体系。历史 CHG 目录会让整个仓库永久受管，包括与任何 CHG 无关的目录。
3. `fallback` 返回 `checks: []`。策略文件损坏 → 门控静默失效，且 headless 下只有 stderr 一行。这是「假绿式安全」。

## 改动

| 文件 | 改动 |
|---|---|
| `bridge/gates/policy.js` | `scanForSecrets` 邮箱改为上下文规则；新增 `chg_contract_scope_globs` 与匹配逻辑；`DEFAULT_CONFIG` 同步 |
| `bridge/gates/pi/index.js` | `fallback` 改为 degraded 安全策略（3 项 hard checks），session_start 明确告警 |
| `bridge/gates/pi/policy.json` | version 4；同步配置 |
| `bridge/test/*` | 邮箱正/反例、scope 正/反例、degraded 用例 |
| `docs/ADR/008-...` | 记录 fail-closed 的取舍与误伤收敛原则 |

## 未做

- 未引入完整 secret 扫描器（仓库已有 `scripts/scan-secrets.sh` 负责提交前全量扫描；门控只做「即将写入的内容」这一道）。
- 未自动识别 ADR/RFC/Jira 体系；判据仍是文件系统事实。
