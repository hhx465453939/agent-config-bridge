---
change_id: CHG-20261105-gate-bypass-mode
delivery_status: delivered
generated_by: manual
---

# TRACEABILITY · PRD → SPEC → AC → 证据（实测）

## PRD → SPEC → AC

| PRD | SPEC 目标 | AC |
|---|---|---|
| P-1 模式开关 | §1.1 / §1.2 | AC-1、AC-14 |
| P-2 一条命令一劳永逸 | §1.7 | AC-16 |
| P-3 只对当前会话生效 | §1.6 / §1.7 | AC-18 |
| P-4 自动到期 | §1.2 / §1.7 | AC-11、AC-12、AC-17 |
| P-5 bypass 不等于裸奔 | §1.4 | AC-4 |
| P-6 其他门控不牵扯 | §1.3 | AC-8、AC-9、AC-10 |
| P-7 agent 不能自己切 bypass | §1.5 | AC-6、AC-7 |
| P-8 bypass 可见 | §1.8 | AC-19 |
| P-9 两端都遵守 | §1.9 / §1.10 | AC-20 |
| P-10 可回退 | §1.7 | AC-17、AC-18 |
| （权限层放行本身） | §1.2 | AC-3、AC-5 |

## AC → 实现位置 → 证据（用例名）

全部证据在 `bridge/test/gate-bypass.test.js`：

| AC | 实现位置 | 证据（用例名） |
|---|---|---|
| AC-1 | `policy.js::DEFAULT_CONFIG.destructive_mode` | 「mode: the shipped default is enforce, and bypass is the only alternative」 |
| AC-2 | `policy.js::no-destructive-bash` 的 confirm 分支 | 「mode: enforce still asks for a recoverable delete」 |
| AC-3 | `no-destructive-bash` 的 bypass 分支 | 「bypass: a recoverable delete runs without asking」 |
| AC-4 | `no-destructive-bash` 的 `severity === 'high'` 早返回（在 bypass 之前） | 「bypass: the unrecoverable red lines still block」 |
| AC-5 | 同 AC-3（deny 档不再返回） | 「bypass: a deny-tier category is open too」 |
| AC-6 | `no-self-grant` 内容判据 `destructive_grants\|destructive_mode` | 「bypass: no-self-grant still refuses a write that carries destructive_mode」 |
| AC-7 | `no-self-grant` 只保护两个键 | 「bypass: an unrelated edit of the same file is still allowed」 |
| AC-8 | `shouldBlock` 无按模式跳过的分支 | 「bypass: the research rules still fire (scope is destructive only)」 |
| AC-9 | `reminderFor` 无 bypass 特例 | 「bypass: the per-turn reminder is untouched」 |
| AC-10 | pi `turn_end` 无 bypass 特例 | 「pi: turn_end still catches a deferral in bypass」 |
| AC-11 / AC-12 | `effectiveDestructiveMode` 的 until 分支 | 「expiry: a past destructive_mode_until is enforce again」/「expiry: a future one is still bypass」 |
| AC-13 | `effectiveDestructiveMode` 的会话覆盖分支 | 「session override: wins in both directions」 |
| AC-14 | `normalizeDestructiveMode` / `normalizeDestructiveModeUntil` | 「normalize: an unknown mode and a junk expiry fall back to enforce/0」 |
| AC-15 | `pi/index.js::parseGateDurationMs` / `formatDurationMs` | 「duration: parses the documented forms and refuses the rest」 |
| AC-16 | `/gate mode` 的全局写入分支 | 「/gate mode bypass persists to the machine override」 |
| AC-17 | 同上 + 到期计算 | 「/gate mode bypass 30m writes an expiry, and enforce clears it」 |
| AC-18 | `/gate mode … session` 只改 `state.destructiveMode` | 「/gate mode bypass session stays in memory and can be cleared」/「/gate mode refuses a duration it cannot parse, without writing」 |
| AC-19 | `report()` 首行 + `session_start` 告警 | 「/gate list states the active mode first」/「pi: session_start announces a bypass on stderr」 |
| AC-20 | `dsh/index.js` 启动告警 + policy.json | 「dsh: a bypass override is honoured and announced」/「config: both shipped policies declare the mode keys」 |

## 实测记录

- `node --test`：全绿（含既有 37 条 gate-destructive 回归）。
- `node --check bridge/cli.js`：通过。
- `bash scripts/scan-secrets.sh`：无命中。
