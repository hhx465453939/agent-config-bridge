---
change_id: CHG-20261029-agent-config-bridge-gate-scope
status: approved
---

# CHANGE · 为什么改

## 背景

2026-10-29 新增 `chg-contract-before-edit`（ai-spec 门控）后，连续暴露两个缺陷：

**缺陷 1（静默失效）**：首版把 `chg_contract_globs` 写成小写并要求配置也小写。
原因是 `normalizePath` 会小写化路径，而 `matchesAnyGlob` 不做大小写归一。
配置若写成自然的大写形态，门控**永不触发**——最危险的失效形态：看起来有保护，实际没有。
这不是配置问题，是代码缺陷：**程序应适配输入，不应要求人手写小写**。

**缺陷 2（死锁）**：本仓库用 ADR 管理变更，没有 `tasks/CHG-*/`。
门控生效后，改任何代码都要求「先读 CHG 契约」，而本仓库不存在该文件——
于是连**修门控自身**都被拦截，形成死锁。

## 决策

1. `isChgContract` 对「路径」与「glob」**两侧统一小写化**，配置可写自然大写。
2. `chg-contract-before-edit` 增加**项目适用性**判断：`tasks/` 不存在，
   或存在但无 `CHG-*` 子目录 → 判定本项目不采纳 CHG 体系 → 跳过。
3. `DEFAULT_CONFIG` 与 `policy.json` 的 globs 改回自然大写，作为对缺陷 1 的回归证据。

## 影响范围

- 仅 `bridge/gates/**` 与本仓库文档；不涉及 targets、MCP、部署脚本。
- 行为变化：不用 CHG 的仓库不再被拦；用 CHG 的仓库行为不变（AC-5 守住）。
