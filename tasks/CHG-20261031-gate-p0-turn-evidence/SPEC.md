---
change_id: CHG-20261031-gate-p0-turn-evidence
status: approved
created: 2026-10-31
owner: pi
---

# CHG-20261031 · 门控 P0：轮次级拦「不偷懒」+ 证据 TTL + Layer 2 真正生效 + 上限窗口

## 1. 目标（可判定终态）

把「每轮有效拦截」从**只覆盖工具动作**扩展到**覆盖纯文本交付**，并修掉三个让门控在长会话里失真的缺陷：

1. **轮次级 no-slack**：助手一轮结束时，若交付文本出现「稍后再做 / 后续 / 下一轮再 / 先不处理 / TODO 占位」等**第一人称拖延承诺**，门控返回 `continue: true` 强制再跑一轮，而不是把话术当交付。
2. **inspected 证据带 TTL**：读过一个文件不再永久解锁它的编辑；超过 `inspected_ttl_ms` 需要重读或重新图谱点名。
3. **Layer 2 索引过期检测真正生效**：不再依赖仓库内 `.codebase-memory` marker；改为「本会话成功调用过 `index_repository` / `detect_changes` 的时间戳」与目标文件 mtime 比较。marker 存在时仍沿用 marker 逻辑。
4. **拦截上限按窗口重置**：`max_blocks_per_session` 从 30 提到 200，并新增 `block_cap_reset_ms`（默认 30 分钟）滑动重置；安全类检查（`HARD_CHECKS`）仍然完全不受上限影响。

## 2. 独占文件

- `bridge/gates/policy.js`
- `bridge/gates/pi/index.js`
- `bridge/gates/pi/policy.json`
- `bridge/test/gate-policy.test.js`
- `bridge/test/gate-adapter.test.js`（新增）
- `docs/ADR/006-gate-turn-level-and-evidence-ttl.md`

## 3. 验收断言（每条都能红）

| AC | 断言 | 破坏方式 |
|---|---|---|
| AC-1 | 读文件后经过 `inspected_ttl_ms` 再改同一文件 → `THINK_TARGET` | 把 `hasFreshInspection` 改回无限期 `Set.has` → 红 |
| AC-2 | 读文件后在 TTL 内改同一文件 → 放行 | 去掉 TTL 判断（永远拦截）→ 红 |
| AC-3 | 文件 mtime 晚于本会话最后一次 `index_repository` 成功时间 → `INDEX_STALE` | 删掉 evidence 分支 → 红 |
| AC-4 | 文件 mtime 早于最近一次索引刷新 → 放行 | 无条件拦截 → 红 |
| AC-5 | 无 marker 且无索引证据 → 该检查 abstain（不误拦） | 无条件拦截 → 红 |
| AC-6 | 拦截计数达到上限后，超过 `block_cap_reset_ms` 窗口自动重置 | 去掉窗口重置 → 红 |
| AC-7 | 安全类检查在超限后仍然拦截 | 把 `no-secret-write` 移出 `HARD_CHECKS` → 红 |
| AC-8 | 助手文本「这个我稍后再补」→ `slackFinding` 命中 | 删掉该正则 → 红 |
| AC-9 | 助手文本「下一步你可以运行 node --test」→ 不命中（不是第一人称拖延） | 放宽成 `/下一步/` → 红 |
| AC-10 | 代码块内的 `TODO: implement` 不触发 no-slack | 去掉 fenced-code 过滤 → 红 |
| AC-11 | `turn_end` 命中 no-slack 时返回 `continue: true` 并注入 custom_message | adapter 不注册 turn_end → 红 |
| AC-12 | 全量单测绿 + `node --check` 通过 | 任一用例失败 |
| AC-13 | `bash scripts/scan-secrets.sh` 无命中 | 引入真实值 |

## 4. 绝不做什么

- 不把 no-slack 做成「无限续跑」：每会话有 `slack_max_continues` 上限（默认 2），达到后停止续跑并放行，避免把 agent 卡死。
- 不把 no-slack 建在「关键词出现即拦」上：必须只匹配**第一人称/本任务**的拖延承诺，代码块与引用块内的文本豁免。
- 不改变「安全规则永远生效」的语义。
- 不引入第三方依赖。
- 不让 `.codebase-memory` marker 成为 Layer 2 的唯一入口。
