# ADR-006 · 轮次级门控与「证据会过期」

- 状态：accepted
- 日期：2026-10-31
- 相关：ADR-003（硬门控）、CHG-20261031-gate-p0-turn-evidence

## 背景

对一台真实宿主机做全量审计后，发现两条与「每轮有效拦截」直接冲突的事实：

1. **门控只挂 `tool_call`。** 模型一整轮不调用任何工具、只输出「这个我稍后再补」，四条硬门控一个都不触发。偷懒最典型的形态恰好是「不动手、只许诺」。
2. **读取证据永不过期。** `state.inspected` 是 `Set`，一次 `read` 永久解锁该文件的编辑。`think-before-write` 的「动手前看过」退化成「会话里看过一次」；第 2 轮看过，第 50 轮照改不误。
3. **Layer 2 名存实亡。** `index-freshness-before-read` 依赖仓库内 `.codebase-memory` 标记，而 codebase-memory 默认把索引存在全局数据目录；实测 5 个已索引项目全部没有该标记，这条检查永远 abstain。
4. **上限是会话终身 30 次。** 长会话很容易在前期用光，之后研究规则全灭。

## 决策

1. **新增轮次级 `turn_end` 钩子**，用 `slackFinding()` 扫描助手最终文本。命中第一人称拖延承诺时返回 `continue: true` 并注入一条 `custom_message`，强制再做一轮。每会话最多续跑 `slack_max_continues` 次（默认 2），防止误判导致死循环。
2. **`inspected` 改为 `Map<path, ts>`**，新增 `hasFreshInspection()`，TTL 由 `inspected_ttl_ms` 控制（默认 30 分钟，`-1` 恢复旧行为）。
3. **Layer 2 增加会话证据分支**：本会话成功调用过 `index_repository` / `detect_changes` 时记录 `lastIndexRefreshAt`；文件 mtime 晚于该时间即判 `INDEX_STALE`。仓库内 marker 存在时仍优先用 marker。两者都没有时 abstain（由 Layer 1 继续兜底）。
4. **上限改为滑动窗口**：`max_blocks_per_session` 默认 200，`block_cap_reset_ms` 默认 30 分钟；安全规则仍完全不受限。

## 取舍

- **不做语义判断**：no-slack 是有限正则集合，宁可漏判也不误伤正常问答。代码围栏与引用块内的文本豁免。
- **不做无限续跑**：次数上限是必要的保险；否则一个错误正则会把 agent 扣在同一轮。
- **不自动重建索引**：门控只负责拦截并给出正确动作，不做有副作用的索引工作。
- **不把 `index-before-read` 默认打开**：全局索引不可探测，开了会误拦。

## 后果

- 纯文本轮次也受「不偷懒」约束；代价是可能出现一次「误判后强制继续」，由次数上限兜底。
- 长会话不再因累计 30 次拦截而整体失效。
- 没有 marker 的项目也能被 Layer 2 管住，但前提是本会话真的调用过索引工具；否则仍是 Layer 1 兜底。
