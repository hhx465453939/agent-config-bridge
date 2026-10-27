# ADR-007 · 工具与作用域覆盖：PowerShell、MCP 网关、机器本地根

- 状态：accepted
- 日期：2026-10-31
- 相关：ADR-003（硬门控）、CHG-20261031-gate-p1-coverage

## 背景

审计发现四条「换个工具/换个目录就能绕过」的通道：

1. `READ_TOOLS` / `WRITE_TOOLS` / `bash` 三个分支不含 pi 的 `powershell` 工具。Windows 主机上启用该工具即完整绕过读、写、破坏性检查。
2. `tool_call` 对 `toolName === 'mcp'` 直接 return。当前用户把 MCP 工具直连暴露所以尚未成洞，但启用网关或 filesystem MCP 后就是通道。
3. `scopeOf` 在没有 `project_roots` 时只认 `.git`；`~/.pi`、`~/.claude/skills`、`~/mcp`、未 `git init` 的脚本目录全部不受管（实测读 82KB 源码零拦截）。
4. `code_extensions` 缺 `yml/yaml/ipynb` 等，配置与 Notebook 裸奔。

## 决策

1. **PowerShell 与 bash 同级**：新增 `parsePowerShell()` 与 `powershell{Read,Write,Dir,Destructive}` helper；适配层把 `toolName === 'powershell'` 归一成 `action: 'bash'` + `shell: 'powershell'`；规则引擎用 `shellReadTargets/shellWriteTargets/shellDestructiveFinding` 统一分发。
2. **MCP 网关解包**：`tool_call` / `tool_result` 里若 `toolName === 'mcp'`，用 `input.tool` 作为真实工具名、`input.args` 作为真实参数，再走同一套判定。
3. **机器本地作用域**：`resolvePolicy` 深合并 `~/.config/agent-config-bridge/gate-policy.json` 的 `config`（仓库外、不含凭据）。仓库内保持 `project_roots: []`，不写死任何人的路径。
4. **扩展名补齐**：`ps1/psm1/yml/yaml/ipynb/json5/tfvars/hcl/nix/dart/groovy`。

## 取舍

- **不做 PowerShell AST 解析**：零依赖，且门控不应执行命令。只做保守的词汇表与操作数提取；无法解析的跳过。
- **`project_roots` 保持独占语义**：非空即替代 `.git` 探测。因此 `bootstrap` 只在显式 `--root` 时写机器配置，避免用不完整的候选列表意外缩小作用域。
- **机器覆盖只允许 `config`**：`checks` 与规则文本仍由仓库拥有，防止某台机器静默关掉检查。
- **MCP 只做工具名解包**：不承诺 MCP 自身语义安全；只保证它经过与内置工具同一套路径判定。

## 后果

- 启用 `powershell` 不再等于关掉门控；代价是 PowerShell 解析覆盖有限（常见读写删动词 + `-Path` 类标志）。
- 非 git 目录可以通过机器配置纳入门控；代价是每台机器需要自己声明开发根。
- MCP 网关不再整段跳过；代价是适配层多一层解包逻辑，需要测试守着。
