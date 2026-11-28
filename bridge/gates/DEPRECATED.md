# DEPRECATED — 硬门控已迁至 ShipGate

**本目录自 2026-11-27 起冻结，不再演进。**

## 为什么

硬门控（破坏性命令分级、图谱优先、思考前置、密钥写入、越界写入、AI4S 域检查……）与开发门控、
slop 清理、debug 审计同属一类职责，已统一收敛到 **ShipGate**：

| 项 | 新位置 |
|---|---|
| 门控产物 | `ShipGate/assets/gates/` |
| 策略真源 | `~/.config/shipgate/gate-policy.json` |
| 安装 / 同步 | `shipgate install --harness pi|dsh` / `shipgate policy --sync` |
| 续跑扩展 | `ShipGate/assets/pi-extensions/`（`shipgate install --with-goal-mode`） |

`ShipGate/assets/gates/policy.js` 当前已比本目录版本更新。

## 本目录现在的用途

- 作为 `ShipGate/assets/gates/` 的上游历史快照。
- `bridge/test/gate-*.test.js` 的被测对象仍在，用于保证冻结代码不被误改。

## agent-config-bridge 现在的职责

只剩四维桥接：**skills / commands / rules-doc / MCP**。
`bridge/targets/pi.json` 与 `dsh.json` 的 `gates.supported` 已置为 `false`。

## 移除计划

下个大版本删除本目录与 `bridge/lib/gates.js`、`bridge/gates/`、相关的
`scripts/install-pi-{goal-mode,auto-continue}.js`。
