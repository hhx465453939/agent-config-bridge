---
change_id: CHG-20261031-gate-skill-bootstrap
status: delivered
---

# CHANGE · 改了什么、为什么

## 根因

1. 门控代码已经在仓库里，但新机器只有「README 快速开始」，没有一条覆盖「装门控 + 装共享技能 + 验证」的路径。部署靠人记。
2. 用户的原则（动脑子 / codebase 优先 / 不偷懒）只写在 AGENTS.md 与 APPEND_SYSTEM 里，没有沉淀成可移植的技能资产。
3. 仓库里没有任何技能样例，`skills/` 维度只从 `~/.claude` 单向复制，无法随仓库分发。

## 改动

| 文件 | 改动 |
|---|---|
| `skills/agent-hard-gates/SKILL.md` | 新增全局技能：三铁律、机器判据、部署、自检、扩展方法、红线 |
| `scripts/bootstrap.js` | 新增跨平台一键部署：detect → adopt → apply → verify → 机器覆盖建议 |
| `scripts/install-hard-gate-skill.js` | 新增技能安装（plan 优先、幂等、冲突保留用户版本） |
| `README.md` | 新增「新宿主机部署硬门控」章节 + 目录结构 + 技能说明 |
| `docs/USAGE.md` | 新增 §5.10 一键部署 与 §6.2 技能共享 |
| `docs/ADR/009-...` | 记录「仓库分发技能、Claude 为权威源、pi 链接共享」的取舍 |
| `bridge/test/bootstrap.test.js` | 清单级测试：计划生成、幂等、缺 pi 报错 |

## 未做

- 未把技能塞进 `bridge/targets/pi.json` 的 `managed`（技能权威源在 `~/.claude`，由安装脚本 seed，避免与用户自管技能冲突）。
- 未自动安装 pi / MCP adapter；由 `doctor` 继续报告缺失。
