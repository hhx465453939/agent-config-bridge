---
change_id: CHG-20261031-gate-p1-coverage
status: delivered
---

# CHANGE · 改了什么、为什么

## 根因

1. `READ_TOOLS` / `WRITE_TOOLS` / `bash` 三个分支不含 `powershell`，而 pi 在 `defaultTools` 里可以启用它。Windows 主机上等于一个完整绕过口。
2. `tool_call` 对 `toolName === 'mcp'` 直接 return。当前用户把 MCP 工具直连暴露所以没炸，但一旦启用网关或 filesystem MCP 就是通道。
3. `scopeOf` 在没有 `project_roots` 时只认 `.git`。`~/.pi`、`~/.claude/skills`、`~/mcp`、未 `git init` 的脚本目录全部不受管（实测：读 82KB `policy.js` 零拦截）。
4. `code_extensions` 缺配置类扩展名。

## 改动

| 文件 | 改动 |
|---|---|
| `bridge/gates/policy.js` | 新增 `normalizePowerShell` 词汇表；`code_extensions` 补 9 个；导出 `powershellReadTargets` / `powershellWriteTargets` / `powershellDestructiveFinding`；`bash*` helper 接受 `shell` 选项 |
| `bridge/gates/pi/index.js` | `tool_call` 增加 `powershell` 分支；`mcp` 解包为 `{tool, args}` 后按真实工具名路由；`tool_result` 的读证据同样支持 powershell / mcp |
| `bridge/gates/pi/policy.json` | version 4；同步新配置 |
| `bridge/lib/paths.js` | 新增 `machineConfigFile(home)` |
| `bridge/lib/gates.js` | `resolvePolicy` 深合并机器覆盖；`planGateInstall` 传入 `home` |
| `bridge/test/*` | PowerShell / MCP / 机器覆盖 / 扩展名用例 |
| `docs/ADR/007-...` | 记录覆盖策略与「仓库零路径」约束 |

## 未做

- 未实现 PowerShell AST 解析（零依赖 + 不执行命令）。
- 未默认填 `project_roots`；只在 `bootstrap` 里生成**建议**文件，由用户确认。
