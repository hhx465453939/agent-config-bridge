---
change_id: CHG-20261031-gate-p1-coverage
status: approved
---

# PRD · 承诺什么 / 不承诺什么

## 承诺

| # | 承诺 | 用户可感知的结果 |
|---|---|---|
| P-1 | Windows 上启用 `powershell` 工具后，门控不会立刻变瞎 | `+powershell` 不再是绕过开关 |
| P-2 | 通过 MCP 网关代理的读写不再整段跳过检查 | 网关不是豁免通道 |
| P-3 | 非 git 目录也能纳入门控，且**每台机器各自配置** | 脚本/工具目录不再裸奔，仓库保持无硬编码 |
| P-4 | 配置类/Notebook 代码文件也被识别 | `.yml` / `.ipynb` 不再漏检 |

## 不承诺

- 不承诺把 PowerShell 的**所有** cmdlet 都建模。只覆盖读、写、删三类高频动词；未知 cmdlet 按「不产生文件目标」处理，除非它带重定向。
- 不承诺自动探测用户所有开发目录。机器覆盖文件由 `bootstrap` 生成建议值，用户可改。
- 不承诺 MCP 工具的语义安全（例如某个 MCP 自己删库）；只保证它经过与内置工具同一套路径判定。

## 边界条件

- PowerShell 映射只做词汇表替换，不执行命令、不做语法分析。
- 机器覆盖文件权限建议 600；不包含任何凭据，只允许改 `policy.config`。
- `resolvePolicy` 的合并顺序：仓库 shipped policy → 清单 `gates.policy` → 机器 `gate-policy.json`。
