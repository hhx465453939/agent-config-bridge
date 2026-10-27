---
change_id: CHG-20261031-gate-p1-coverage
delivery_status: delivered
generated_by: manual
---

# TRACEABILITY · AC → 证据（实测）

| AC | 实现位置 | 证据 | 破坏方式 |
|---|---|---|---|
| AC-1 | `policy.js::normalizePowerShell` / `parsePowerShell` | `gate-v4.test.js`「Get-Content / Select-String are reads」通过 | 删映射 |
| AC-2 | 同上 + `powershellWriteTargets` | 「Set-Content / Out-File / Copy-Item are writes」通过 | 漏写动词 |
| AC-3 | `powershellDestructiveFinding` | 「Remove-Item -Recurse is destructive」通过 | 不映射 |
| AC-4 | `pi/index.js::tool_call` MCP 分支 | `gate-adapter.test.js`「MCP gateway arguments are not exempt」通过 | 不拆包 |
| AC-5 | 同上 | 同用例覆盖写路径；PowerShell 读路径另有用例 | 不拆包 |
| AC-6 | `lib/gates.js::resolvePolicy` | `gate-deploy.test.js`「config is merged, checks are not overridden」通过 | 不深合并 |
| AC-7 | 同上 | 「absent file keeps the shipped policy」通过 | 强制要求文件 |
| AC-8 | `DEFAULT_CONFIG.code_extensions` | `gate-v4.test.js`「config and notebook files are code」通过 | 删除扩展名 |
| AC-9 | — | `node --test` 195/193；`scan-secrets.sh --all` OK | 任一失败 |

## 部署核对

- 本机 `~/.config/agent-config-bridge/gate-policy.json` 已生成：`project_roots = ["<dev-root>", "<home>/mcp"]`。
- 部署后策略已合并该值（`project_roots` 不再为空），且 `checks` 顺序未被机器配置覆盖。
- 首次部署曾因「先 apply 后写机器配置」导致 `project_roots` 为空；已修正 bootstrap 顺序（先写机器配置，再 apply），并重新部署验证。
