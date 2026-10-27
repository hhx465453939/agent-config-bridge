---
change_id: CHG-20261031-gate-skill-bootstrap
status: approved
---

# PRD · 承诺什么 / 不承诺什么

## 承诺

| # | 承诺 | 用户可感知的结果 |
|---|---|---|
| P-1 | 新机器 clone 后一条命令完成门控部署 | 不再靠手动拷文件 |
| P-2 | Windows 与 Linux 用同一套命令 | 文档不需要分叉两套流程 |
| P-3 | 全局技能一份、Claude 与 pi 共享 | 改技能只改一处 |
| P-4 | 技能自带「怎样证明门控在拦」的自检 | 装完能自证 |
| P-5 | 机器本地路径配置与仓库分离 | 公共仓库零隐私泄漏 |

## 不承诺

- 不承诺自动安装 pi 本身或 `pi-mcp-adapter`；缺失时明确报出安装命令（沿用 `requires` 机制）。
- 不承诺自动改用户的 `settings.json` / `mcp-adapter.json` 等 `never_touch` 文件。
- 不承诺把仓库内技能强行覆盖到用户已有同名技能；冲突时报告并保留用户版本。
- 不承诺对 Kimi 等无扩展机制的 agent 提供硬门控（manifest 已声明 `supported: false`）。

## 边界条件

- `bootstrap` 的写盘动作全部委托给现有 `bridge/cli.js`（adopt/apply），不复制一套写入逻辑。
- 机器本地覆盖文件：`~/.config/agent-config-bridge/gate-policy.json`（Windows 为 `%USERPROFILE%\.config\...`）。
- 技能目录：`~/.claude/skills/agent-hard-gates/`；pi 通过 `~/.agents/skills` 链接读取。
