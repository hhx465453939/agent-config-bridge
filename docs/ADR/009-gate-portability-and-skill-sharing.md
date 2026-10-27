# ADR-009 · 门控可移植：仓库分发技能，Claude 持有源，pi 链接共享

- 状态：accepted
- 日期：2026-10-31
- 相关：ADR-001（桥接架构）、CHG-20261031-gate-skill-bootstrap

## 背景

门控代码已经在仓库里，但新机器只有「README 快速开始」，没有一条覆盖「装门控 + 装共享技能 + 验证」的路径。部署靠人记；三条铁律只存在于 `AGENTS.md` 与 `APPEND_SYSTEM.md`，不是可移植资产。

同时，`bridge/targets/pi.json` 把 `skills` 声明为「链接到 `~/.claude/skills`」，即 Claude 是权威源。若仓库再把技能复制到 pi 侧，就会产生第二份副本与漂移。

## 决策

1. **仓库内置 `skills/agent-hard-gates/SKILL.md`**，作为可分发资产。
2. **安装目标只有 `~/.claude/skills/`**：由 `scripts/install-hard-gate-skill.js` 写入；pi 通过既有 `~/.agents/skills -> ~/.claude/skills` 链接读取同一份，不复制。
3. **新增 `scripts/bootstrap.js`**：跨平台（Windows/Linux/macOS）一站式完成 detect → adopt → apply → verify → skill → 机器配置建议。默认 dry-run，`--yes` 才写盘。
4. **仓库内零机器路径**：机器专属的 `project_roots` 写入 `~/.config/agent-config-bridge/gate-policy.json`（仓库外，权限 600）。
5. **文档双份但互补**：README 给最短路径；`docs/USAGE.md` 给运维细节与故障排查。

## 取舍

- **不把技能放进 `managed` 清单**：技能权威源在 `~/.claude`，由安装脚本 seed；放进 `managed` 会在 `apply` 时覆盖用户改过的同名技能。冲突策略改为「默认保留用户版本，`--force` 才覆盖」。
- **不自动安装 pi / MCP adapter**：沿用 `requires` 与 `doctor` 报告，避免工具越界写 `never_touch`。
- **不自动写 `project_roots`**：`project_roots` 非空即独占，自动用不完整候选会让仓库外的 git 项目失去门控。只接受显式 `--root`。

## 后果

- 新机器三条命令完成部署与自证；技能只有一份，Claude 与 pi 不会漂移。
- 用户改过的技能不会被静默覆盖；代价是需要 `--force` 才能接收仓库更新。
- 仓库保持零真实路径/凭据，可直接公开。
