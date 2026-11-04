---
change_id: CHG-20261104-ai4s-domain-gates
delivery_status: delivered
generated_by: manual
---

# TRACEABILITY · PRD → SPEC → AC → 证据（实测）

## PRD → SPEC → AC

| PRD | SPEC 目标 | AC |
|---|---|---|
| P-1 域识别 | §1.1 / §1.2 | AC-1、AC-2、AC-8 |
| P-2 三层兜底 | §1.1 / §1.7 | AC-1、AC-2、AC-7 |
| P-3 跑前 Worklog | §1.3 | AC-3、AC-4 |
| P-4 脚本日志 | §1.4 | AC-5、AC-6 |
| P-5 结果目录说明 | §1.5 | AC-6 |
| P-6 产物只「再要一轮」 | §1.5 / §1.6 | AC-6、AC-9c |
| P-7 两端同源 | §1.6 | AC-9 |

## AC → 实现位置 → 证据

| AC | 实现位置 | 证据（实测通过的用例） | 破坏方式 |
|---|---|---|---|
| AC-1 | `classifier.js::fingerprintHit` / `classify` | `gate-ai4s.test.js`「AC-1: structural fingerprints decide the domain without asking a model」— 断言 `source=fingerprint` 且 `modelCalls===0` | 删 T0 → 红 |
| AC-2 | `classifier.js::keywordHit`（`min_hits` 门槛） | 「AC-2: one weak keyword is a question, not a research session」→ `general-dev`/`fallback`；「AC-2b: two distinct strong keywords do decide the domain」→ `keyword` | 弱词单独锁定 → 红 |
| AC-3 | `policy.js` `ai4s-worklog-before-run` | 「AC-3: a stale Worklog blocks the first analysis run, with guidance」— 断言 `code=AI4S_WORKLOG` 且 reason 含补救指引 | 删检查 → 红 |
| AC-4 | 同上（窗口 + 首跑判定） | 「AC-4: a fresh Worklog lets the same run through」；「AC-4b: only the first run of a script is judged」 | 无条件拦 / 每次拦 → 红 |
| AC-5 | `policy.js` `ai4s-script-log-source` + `hasLogInitialization` | 「AC-5: a script with no log sink is blocked before it runs」；「AC-5b: reading a script is not running it」 | 删源码检查 → 红 |
| AC-6 | `policy.js::outputArtifactFindings` + `pi/index.js` `turn_end` | 「AC-6: a touched result directory without a note file is a finding」「AC-6b（说明文件消除告警 + 未动目录忽略）」「AC-6c（缺 .log 被报）」「AC-6d（无轮边界不判定）」；边界由「AC-9c: pi asks for one more turn…」证（第二次 `turn_end` 返回 undefined） | 删产物检查 / 去掉上限 → 红 |
| AC-7 | `classifier.js::classify` 的每个 catch 分支 | 「AC-7: a throwing judge degrades…」「AC-7b: a hung judge times out…」（20ms 超时）「AC-7c: a judge naming a profile that does not exist is not trusted」 | 改 fail-closed → 红 |
| AC-8 | `policy.js::activeChecks`（general-dev 无分支） | 「AC-8: the shipped policy keeps its base checks and adds the profile on top」— 直接读仓库 `bridge/gates/pi/policy.json`，断言 `activeChecks(policy,'general-dev')` 与 `policy.checks` 完全相同、且 `pendingProfiles` 为空（profiles/ 真的从磁盘加载）；「AC-8b」对 dsh 的 policy 做同样断言 | 改默认 checks → 红 |
| AC-9 | `pi/index.js` `before_agent_start` + `profilePolicy`；`dsh/index.js` 惰性判定 | 「AC-9: the pi adapter classifies once per turn and applies the profile」「AC-9b: pi stays on general-dev when nothing identifies the domain」「AC-9c」（轮末 continue）「AC-9d: the dsh adapter classifies lazily and applies the same profile」「AC-9e: dsh stays on general-dev when the fingerprints are absent」 | 只改 pi / 只改 dsh → 红 |
| AC-10 | — | `node --test bridge/test/*.test.js` → **EXIT=0，217 tests / 216 pass / 0 fail / 1 skipped**；`bash scripts/scan-secrets.sh` → **EXIT=0，104 文件，0 命中** | 任一失败 |

## 现场证据（不是计划绿）

1. **时间戳容差是实测踩出来的**：`ai4s-script-log-source` 的轮末版（W4 下半）最初用 `log.mtime >= startedAt`，实测「紧接着写出的日志」其 mtime 比 `Date.now()` 早 2–3ms，导致**每次运行必假阳性**。修法沿用仓库既有先例（`index_mtime_epsilon_ms`），新增 `artifact_mtime_epsilon_ms`（默认 2000）。这条在 ADR-010 §7 记录。
2. **安装器漏复制被现成测试抓到**：加完 `classifier.js` 后，`gates.test.js` 的「installed layout really loads (the bug that shipped)」立刻报 `ERR_MODULE_NOT_FOUND: <gate>/classifier.js`。修法是 `planGateInstall` 增加 `classifier.js` 与 `profiles/` 的复制动作——这是「装进去但不生效」这一类洞的现场证据（ADR-003 §4 同源）。
3. **部署核对**：`node bridge/cli.js apply --targets pi` → `+3 ~3 -0`；安装副本 `policy.json` 版本为 **5**，含 `default_profile` 与 `profiles`，`classifier.js` 与 `profiles/*.json` 均落在 `~/.pi/agent/extensions/enforce-rules/`。
4. **doctor 新暴露 3 条 catalog 漂移**：`pi-models` 剥掉 `chat:` 命名空间前缀后，`checkCatalog` 才第一次能真正比对本机 `pi-router-catalog.json`，于是报出 `kimi-for-coding`（262144 vs pi 1048576）、`gpt-5.4-mini`（272000 vs 400000/128000）、`glm-5.1`（200000 vs 204800/202752）。这三条是**真实存在的数据漂移**（此前被前缀缺陷遮蔽），属于 doctor 的报告职责；doctor 按设计不改写用户文件，留给用户决定。
5. **基线修复单独成 commit**：`node --test` 在改动前是红的（`pi-models.test.js` 2 条），先修绿再开发，避免带红基线声称"全绿"。

## 未覆盖（明确不承诺）

- W3 文献验证：不做（ADR-010 §5）。
- `external_judge` 实际调用：只有字段，不实现。
- `ai4s-quant` 的域检查：骨架，`checks: []`。
