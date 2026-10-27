---
change_id: CHG-20261031-gate-p0-turn-evidence
status: delivered
---

# CHANGE · 改了什么、为什么

## 根因

1. **no-slack 缺位**：门控只挂 `tool_call`。模型一轮不动工具、只输出「后续再做」时，没有任何检查点。偷懒最典型的形态恰好是不动手。
2. **inspected 无 TTL**：`state.inspected` 是 `Set`，一次 read 永久解锁该文件。`think-before-write` 的「动手前看过」退化成「会话里看过一次」。
3. **Layer 2 依赖不存在的 marker**：实测 5 个已索引项目全部没有 `<repo>/.codebase-memory`（codebase-memory 默认全局存储），`index-freshness-before-read` 永远 abstain。
4. **上限是会话累计 30 次**：长会话触顶后研究规则全灭，只剩安全检查。

## 改动

| 文件 | 改动 |
|---|---|
| `bridge/gates/policy.js` | `newSessionState` 增加 `indexRefreshes` / `firstBlockAt` / `slackContinues`；`inspected` 改为 `Map<path, ts>`；新增 `hasFreshInspection` / `recordIndexRefresh` / `slackFinding`；`index-freshness-before-read` 增加会话索引证据分支；`shouldBlock` 支持窗口重置；`DEFAULT_CONFIG` 增加 `inspected_ttl_ms` / `block_cap_reset_ms` / `slack_max_continues` / `slack_patterns`，上限改 200 |
| `bridge/gates/pi/index.js` | 新增 `turn_end` 处理器：解析助手文本 → `slackFinding` → `{ continue: true, entries: [...] }`；`tool_result` 记录索引刷新；`session_start` 重置新字段 |
| `bridge/gates/pi/policy.json` | version 4；reminder 增加轮次级条款；同步新配置 |
| `bridge/test/gate-policy.test.js` | 新增 TTL / 索引证据 / 上限窗口 / slack 用例 |
| `bridge/test/gate-adapter.test.js` | 新增 adapter 形状测试（turn_end 返回 continue、索引工具名识别） |
| `docs/ADR/006-...` | 记录「为什么轮次级必须单独存在」「为什么索引证据优先于 marker」 |

## 未做

- 未引入 NLP/LLM 判定 no-slack（零依赖约束 + 可预测性）。
- 未把 `index-before-read` 默认打开（全局索引不可探测，开了会误拦）。
