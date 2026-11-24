---
change_id: CHG-20261124-gate-path-resolution
version: 1
status: approved
created: 2026-11-24
owner: Owner
---

# TRACEABILITY-20261124 · 路径解析缺陷修复

## 需求 → 实现 → 验证

| 需求 | 实现位置 | 验证方式 |
|---|---|---|
| P1 家目录解析为盘符形式（AC-1/AC-2） | `bridge/gates/policy.js` · `resolveShellPath` | 单测：注入 HOME/USERPROFILE 环境形状，断言返回盘符路径 |
| P2 箭头函数不被当作重定向（AC-3） | `bridge/gates/policy.js` · `parseBashCommand` 输出重定向正则 | 单测：`node -e '...=>(...)' > out.txt` 只得到 out.txt |
| P3 特殊设备不产生写入目标（AC-4） | `bridge/gates/policy.js` · `parseBashCommand.pushWrite` | 单测：`2>/dev/null` 的 writes 为空 |
| 不放松真正的越界拦截（AC-5） | 未改动 `withinRoot` 与 `no-write-outside` | 单测：越界样例仍返回 `WRITE_OUTSIDE` |
| P4 非路径字面量不当写入目标（AC-6） | `bridge/gates/policy.js` · 新增 `looksLikePath`，解释器分支 `quotedPaths(script).filter(looksLikePath)` | 单测：含写操作的 node -e 脚本只产出 `out.txt`，不含 `fs` / `utf8` |
| 无回归（AC-6） | 全仓库 | `node --check` + `node --test` + `scan-secrets.sh --history` |

## 部署

- 目标端：`pi`（`bridge/targets/pi.json`，`install_as: enforce-rules`）
- 部署方式：`node bridge/cli.js apply --targets pi`
- 部署后校验：`node bridge/cli.js doctor` 无新增 warn

## 遗留（不在本变更范围）

- policy 不热重载：修改 policy 后需重启宿主进程。属于宿主加载时机，另行处理。
