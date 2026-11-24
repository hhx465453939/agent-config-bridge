---
change_id: CHG-20261124-gate-path-resolution
version: 1
status: approved
prd_ref: PRD.md
created: 2026-11-24
owner: Owner
---

# SPEC-20261124 · 门控路径解析与写入目标提取的三处缺陷修复

## 1. 背景与问题

部署到 pi 的 `enforce-rules` 扩展在 Windows + Git Bash 环境下出现三类误判，
导致合法写入被拦、非路径的命令片段被当作写入目标。三处缺陷在仓库源码
（`bridge/gates/policy.js`）与部署产物中**逐行相同**，因此属于源码缺陷而非部署漂移。

| 编号 | 现象 | 根因位置 |
|---|---|---|
| P1 | `~/.pi/...` 与 `/c/Users/<user>/...` 形式的路径永远不在白名单内 | `resolveShellPath` 使用 `process.env.HOME ?? process.env.USERPROFILE`，Git Bash 的 HOME 是 `/c/Users/<user>`，被 win32 解析成 `\c\Users\<user>`（反斜杠开头、无盘符），与白名单的 `C:\Users\<user>\...` 永不相等 |
| P2 | 含箭头函数的命令被误判为输出重定向，其后代码片段被当成写入路径 | 输出重定向正则 `(?:\d?>>?)\s*` 会把箭头函数 `=>` 中的 `>` 当成重定向符，随后 `[^\s;&|]+` 捕获到 `{...}` 之类的代码片段 |
| P3 | `2>/dev/null` 仍产生写入目标 `\dev\null` | `pushWrite` 用 `candidate.split('/').pop()` 得到 `null`，却拿 `'/dev/null'` 去比对，过滤条件永不成立 |
| P4 | 含写操作的 `node -e` / `python -c` 脚本里，**每个**字符串字面量都被当成写入目标 | `quotedPaths(script)` 提取全部引号内容，且 `writesCall` 是整脚本级判断；于是 `"fs"`、`"utf8"` 这类非路径字面量被 `pushWrite` 当成路径，报出 `C:\Users\<user>\fs` 这样的越界写入 |

## 2. 目标（可判定终态）

1. **P1 修复**：`resolveShellPath` 解析 `~` 与 `~/...` 时，优先采用「盘符形式的家目录」，
   并在家目录是 POSIX 形状（`/c/Users/<user>`）时转换为盘符形式（`C:\Users\<user>`），
   使解析结果能命中 `write_roots` 中的盘符路径。
2. **P2 修复**：输出重定向的识别不得把 `=>`、`>=`、`->`、`-->` 等非重定向运算符当作重定向符。
3. **P3 修复**：`/dev/null`、`nul`、`/dev/stdout`、`/dev/stderr` 无论以何种形式出现都不产生写入目标。
3b. **P4 修复**：解释器脚本里的引号字面量，只有在具备**路径形状**（含路径分隔符，或带文件名扩展名）时才作为读/写目标；`"fs"`、`"utf8"`、`"use strict"` 这类值一律忽略。
4. **不回归**：既有 `node --test` 全部用例保持通过；三处修复只收紧误判，不放松真正的越界拦截。
5. **安全边界不变**：真正的越界写入（`echo x > /etc/passwd`、`cp a ../../outside`）仍然被拦。

## 3. 验收判据（Acceptance Criteria）

- **AC-1**：当 `HOME=/c/Users/<user>` 且 `USERPROFILE=C:\Users\<user>` 时，
  `resolveShellPath('~/.pi/agent/mcp.json')` 返回 `C:\Users\<user>\.pi\agent\mcp.json`（盘符形式）。
- **AC-2**：`resolveShellPath('~')` 返回盘符形式的家目录，而非 `\c\Users\<user>`。
- **AC-3**：对 `node -e 'const f=(a)=>{return 1}' > out.txt` 解析写入目标，结果**只含** `out.txt`，
  不含任何 `{return` 片段。
- **AC-4**：对 `cmd 2>/dev/null` 解析写入目标，结果为空数组。
- **AC-5**：真正的越界写入仍被判为越界：`echo x > /etc/passwd` 产生写入目标且不在白名单内。
- **AC-6**：对 `node -e 'const fs=require("fs");fs.writeFileSync("out.txt","x")'`
  解析写入目标，结果**只含** `out.txt`，不含 `fs` / `utf8` 这类字符串字面量。
- **AC-7**：`node --check` 对 `bridge` 下每个 `.js` 通过；`node --test` 全绿；
  `scripts/scan-secrets.sh --history` 零命中。

## 4. 影响范围

- 仅 `bridge/gates/policy.js`：`resolveShellPath`、`parseBashCommand` 中的输出重定向正则、
  `pushWrite`（bash 与 powershell 两份）、以及新增的路径形状判定 `looksLikePath`
  与解释器分支的过滤。
- 不改变 policy schema、不新增配置项、不新增依赖。
- 部署产物需重新 `apply` 到 pi 目标端后生效。

## 5. 不做的事

- 不引入 policy 热重载（属于宿主加载时机，超出本变更范围）。
- 不改变 `withinRoot` 的判定方式（实测其行为正确，问题在上游路径形状）。
