---
change_id: CHG-20261031-gate-p1-coverage
status: approved
created: 2026-10-31
owner: pi
---

# CHG-20261031 · 门控 P1：补齐工具与作用域覆盖

## 1. 目标（可判定终态）

堵住四条「换个工具/换个目录就能绕过」的通道：

1. **PowerShell 与 bash 同级**：`powershell` 工具的 `Get-Content` / `Select-String`（读）、`Set-Content` / `Add-Content` / `Out-File` / `Copy-Item` / `Move-Item` / `Remove-Item`（写/删）走与 bash 相同的读、写、破坏性检查。
2. **MCP 网关解包**：`tool_call` 若 `toolName === 'mcp'`，按 `input.tool` + `input.args` 还原真实工具名与参数再判定，不再因为网关层而整段跳过。
3. **机器本地作用域**：新增 `~/.config/agent-config-bridge/gate-policy.json`（仓库外、不入库）覆盖 `policy.json` 的 `config`，让非 git 目录（脚本、MCP 源码、技能目录）也能被纳入门控；仓库里仍保持 `project_roots: []`，不写死任何人的路径。
4. **代码扩展名补齐**：`yml/yaml/ipynb/json5/tfvars/hcl/nix/dart/groovy` 纳入 `code_extensions`。

## 2. 独占文件

- `bridge/gates/policy.js`
- `bridge/gates/pi/index.js`
- `bridge/gates/pi/policy.json`
- `bridge/lib/gates.js`
- `bridge/lib/paths.js`
- `bridge/test/gate-policy.test.js`
- `bridge/test/gate-adapter.test.js`
- `docs/ADR/007-gate-coverage-and-machine-overrides.md`

## 3. 验收断言（每条都能红）

| AC | 断言 | 破坏方式 |
|---|---|---|
| AC-1 | `powershell "Get-Content src/a.js"` 被识别为读目标 `src/a.js` | 删 `normalizePowerShell` 映射 → 红 |
| AC-2 | `powershell "Set-Content src/a.js ..."` 被识别为写目标 | 写动词表漏 Set-Content → 红 |
| AC-3 | `powershell "Remove-Item -Recurse -Force src"` 命中破坏性检查 | 不映射 Remove-Item → 红 |
| AC-4 | `toolName='mcp'` + `tool='write'` 的参数按写检查 | adapter 不拆包 → 红 |
| AC-5 | `toolName='mcp'` + `tool='bash'` 的命令按 bash 检查 | 同上 |
| AC-6 | 机器覆盖文件存在时，`resolvePolicy` 深合并 `config`，且不覆盖 `checks` 顺序 | 不做深合并 → 红 |
| AC-7 | 机器覆盖文件不存在时，行为与旧版一致 | 强制要求文件 → 红 |
| AC-8 | `.yml` / `.ipynb` 文件进入 `isCodeFile` | 从扩展名表删除 → 红 |
| AC-9 | 全量单测绿 + `scan-secrets.sh` 无命中 | 任一失败 |

## 4. 绝不做什么

- 不在仓库里写死任何本机绝对路径；机器路径只允许出现在 `~/.config/agent-config-bridge/` 或用户环境变量里。
- 不让 MCP 解包失效时 fail-open：无法确定真实工具名时，按「未知写工具」走写检查（已有 `writeLike` 兜底）。
- 不改变 bash 解析的既有语义，只做 PowerShell → bash 词汇表的等价映射。
- 不引入第三方依赖。
