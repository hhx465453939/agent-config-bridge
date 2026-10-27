# ADR-008 · 失败关闭与误伤收敛

- 状态：accepted
- 日期：2026-10-31
- 相关：ADR-003（硬门控）、CHG-20261031-gate-p2-hardening

## 背景

1. `SECRET_PATTERNS` 把「任意邮箱」判成凭据。本轮立项文档就因为含示例邮箱被自己的门控拦了两次。误伤会训练用户关掉检查，最终让真检查也失效。
2. `chg-contract-before-edit` 只按「仓库有 `tasks/CHG-*`」判断是否采纳 CHG 体系；历史 CHG 会让整个仓库永久受管，包括与任何 CHG 无关的目录。
3. `fallback` 返回 `checks: []`：策略文件损坏 → 门控静默失效，headless 下只有 stderr 一行。这是「假绿式安全」。

## 决策

1. **邮箱只在凭据上下文里算风险**：移除独立邮箱正则；仅当邮箱前后 40 字符内出现 `password|passwd|secret|token|api[_-]?key|credential` 时才命中。
2. **新增 `chg_contract_scope_globs`**（默认 `[]` = 旧行为）：非空时只对匹配的路径要求 CHG 契约。
3. **fallback 失败关闭**：策略读不出来时保留 `no-write-outside` + `no-secret-write` + `no-destructive-bash` 三项安全规则，`max_blocks_per_session: 0`（只跑安全规则），并在 `reminded` 里明确写「门控降级」。

## 取舍

- **不追求语义级凭据识别**：只收敛已知误伤点。仓库另有 `scripts/scan-secrets.sh` 负责提交前全量扫描；门控只管「即将写入的内容」这一道。
- **不自动识别 ADR/RFC/Jira 体系**：判据仍是文件系统事实；需要收窄就用 `chg_contract_scope_globs`。
- **degraded 不启用研究规则**：那些规则依赖会话证据与 CHG 文档读取状态；在策略损坏时强行启用会锁死。安全底线不依赖这些状态。

## 后果

- 写 README/文档里的普通邮箱不再被拦；真正的 `password: <邮箱>` 仍被拦。
- 历史 CHG 不再拖累全仓库；代价是需要团队显式声明治理范围。
- 策略损坏时不会「看起来在管、其实没管」；代价是可能出现一次明确的 degraded 告警与受限门控。
