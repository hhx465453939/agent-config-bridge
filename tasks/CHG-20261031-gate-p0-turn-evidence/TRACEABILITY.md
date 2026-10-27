---
change_id: CHG-20261031-gate-p0-turn-evidence
delivery_status: delivered
generated_by: manual
---

# TRACEABILITY · AC → 证据（实测）

| AC | 实现位置 | 证据 | 破坏方式 |
|---|---|---|---|
| AC-1 | `policy.js::hasFreshInspection` + `think-before-write` | `node --test bridge/test/gate-v4.test.js` → 「a read expires after inspected_ttl_ms」通过 | 改回 `Set.has` |
| AC-2 | 同上 | 同用例前半段（TTL 内放行）通过 | 去掉 TTL 判断 |
| AC-3 | `policy.js::index-freshness-before-read` | 「file newer than the session index refresh is stale」通过 | 删 evidence 分支 |
| AC-4 | 同上 | 同用例前半段（早于刷新放行）通过 | 无条件拦截 |
| AC-5 | 同上 | 「no marker and no refresh evidence abstains」通过 | 无条件拦截 |
| AC-6 | `policy.js::shouldBlock` | 「research rules resume after block_cap_reset_ms」通过 | 去掉窗口重置 |
| AC-7 | `HARD_CHECKS` | 「safety checks ignore the cap」通过 | 移出 HARD_CHECKS |
| AC-8 | `policy.js::slackFinding` | 「first-person deferral is caught」通过 | 删正则 |
| AC-9 | 同上 | 「ordinary advice and code are not deferrals」通过 | 放宽正则 |
| AC-10 | 同上（fenced code 过滤） | 同用例代码块分支通过 | 去掉过滤 |
| AC-11 | `pi/index.js::turn_end` | `gate-adapter.test.js` 两个 turn_end 用例通过；部署后人工触发待下次会话验证 | 不注册 turn_end |
| AC-12 | — | `node --test`：195 tests / 193 pass / 0 fail / 2 skipped | 任一失败 |
| AC-13 | — | `bash scripts/scan-secrets.sh --all` → `OK: no sensitive content found.` | 引入真实值 |

## 备注

- AC-11 的「真实 pi 进程内触发」需要 `/reload` 后由下一轮对话验证；适配层返回结构与次数上限已由单测锁定。
- 部署后 `~/.pi/agent/extensions/enforce-rules/policy.json` 的 `version=4`、`slack_check=true`、`cap=200`、`reset=1800000`、`ttl=1800000` 已核对。
