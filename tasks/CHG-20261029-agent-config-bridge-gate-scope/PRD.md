---
change_id: CHG-20261029-agent-config-bridge-gate-scope
status: approved
---

# PRD · 承诺什么 / 不承诺什么

## 承诺

| # | 承诺 | 用户可感知的结果 |
|---|---|---|
| P-1 | 配置里 glob 写大写、写小写、写混写，行为一致 | 不再需要「记住要小写」这种隐性知识 |
| P-2 | 不用 CHG 体系的仓库可以正常改代码 | `agent-config-bridge`、`Claude_skill_pool` 等不被死锁 |
| P-3 | 用 CHG 体系的仓库（如 `xuanji-brain`）仍强制先读契约 | 防跑偏能力不退化 |
| P-4 | 同时修好，两个 bug 一起交付 | 不再出现「修了一个又踩另一个」 |

## 不承诺

- 不承诺对所有项目结构自动识别「变更管理体系」。判据只有一条文件系统事实：
  `tasks/` 下有无 `CHG-*` 子目录。ADR / RFC / Jira 等体系不在识别范围内。
- 不承诺向后兼容「配置必须全小写」的旧约定——该约定本身是缺陷，不保留。
- 不承诺为 CHG 体系提供模板生成；那是 `dev-host-init` / `ai-spec` 的职责。

## 边界条件

- 项目根由 `project_roots` 决定；`project_roots` 为空时依赖 `scopeOf` 的默认推断。
- 若 `tasks/` 存在但无读取权限，`listDir` 返回空 → 视为不采纳 CHG（宁可漏拦，不可死锁）。
