---
change_id: CHG-20261031-gate-skill-bootstrap
status: approved
created: 2026-10-31
owner: pi
---

# CHG-20261031 · 硬门控可移植：全局 skill + 跨宿主一键部署

## 1. 目标（可判定终态）

让「agent-config-bridge 是门控唯一真源」这件事**在任何一台新宿主机上可识别、可部署、可验证**：

1. **全局 skill**：仓库内置 `skills/agent-hard-gates/SKILL.md`，安装到 `~/.claude/skills/agent-hard-gates/`；由于 `~/.agents/skills` 是指向 `~/.claude/skills` 的链接，pi 自动共享同一个技能，无需第二份副本。
2. **跨平台一键部署**：新增 `scripts/bootstrap.js`（Node，Windows/Linux/macOS 通用），自动完成：探测 agent → `adopt pi` → `apply` → 校验门控文件在位 → 生成机器本地 `gate-policy.json` 建议值 → 提示重启/`/reload`。
3. **文档可闭环**：README 与 `docs/USAGE.md` 新增「新宿主机部署硬门控（Windows/Linux）」章节，包含从 clone 到验证的完整命令，以及「如何确认门控真的在拦」的红色断言。
4. **技能可验证**：skill 里给出 3 条可执行自检命令，新机器照做即可判断门控是否生效。

## 2. 独占文件

- `skills/agent-hard-gates/SKILL.md`（新增）
- `scripts/bootstrap.js`（新增）
- `scripts/install-hard-gate-skill.js`（新增，幂等 + plan 优先）
- `README.md`
- `docs/USAGE.md`
- `docs/ADR/009-gate-portability-and-skill-sharing.md`
- `bridge/test/bootstrap.test.js`（新增，纯函数/清单级测试）

## 3. 验收断言（每条都能红）

| AC | 断言 | 破坏方式 |
|---|---|---|
| AC-1 | `node scripts/bootstrap.js --dry-run` 在无 pi 目录时明确报「未检测到 pi」且退出码非 0 | 写成静默跳过 → 红 |
| AC-2 | 有 pi 目录时 dry-run 输出 adopt/apply/校验三步计划，且不写盘 | 加写盘调用 → 红 |
| AC-3 | `--yes` 后 `~/.pi/agent/extensions/enforce-rules/policy.json` 存在且含 `graph-before-read` | 跳过 apply → 红 |
| AC-4 | `install-hard-gate-skill.js` 幂等：第二次运行报 `keep` 且不覆盖用户改过的文件 | 无条件覆盖 → 红 |
| AC-5 | skill 目录出现在 `~/.claude/skills/agent-hard-gates/`，且 `~/.agents/skills/agent-hard-gates` 可读（链接共享） | 复制到两个位置造成漂移 → 红 |
| AC-6 | README / USAGE 同时包含 Windows 与 Linux 命令，且不含任何真实路径/IP/邮箱 | 跑 `scan-secrets.sh` → 红 |
| AC-7 | 新机器文档路径不含 `C:\Users\<real>`、`/home/<real>` 等真实家目录 | 写死真实用户名 → 红 |
| AC-8 | 全量单测绿 | 任一失败 |

## 4. 绝不做什么

- 不在仓库写死任何本机绝对路径（技能、脚本、文档一律用 `~` / 环境变量 / `os.homedir()`）。
- 不让技能出现第二份副本：pi 侧只通过既有 `~/.agents/skills` 链接共享。
- 不把 `bootstrap` 做成「无提示全自动」：默认 dry-run，只有显式 `--yes` 才写盘。
- 不修改 `never_touch` 里的任何用户私有配置。
