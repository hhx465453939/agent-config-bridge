# PRD — bridge 收缩为纯桥（门控与续跑迁出）

- 变更编号：`CHG-20261127-bridge-scope-narrowing`
- 状态：approved
- 配套：ShipGate 侧 `CHG-20261127-deploy-topology-consolidation`（承接方）

## 1. 背景

本机实测（2026-11-27）出现三重重复：

| 症状 | 证据 |
|---|---|
| pi 加载两份门控 | `~/.pi/agent/extensions/` 同时有 `coding-gateways`（bridge）与 `enforce-rules`（ShipGate） |
| dsh 挂错产物 | profile 曾挂 `agent-config-gates`（bridge），ShipGate 的 `enforce-rules` 是死代码 |
| policy 双真源 | bridge `bypass` vs ShipGate `enforce`，拦截行为取决于加载顺序 |

ShipGate 已交付：27 skill + 4 闸 + 硬门控（基于 bridge 导出的产物，且 `policy.js` 已比 bridge 版本更新）+ 续跑扩展承接（`assets/pi-extensions/`）。

项目定位（主人 2026-11-27 明确）：

> bridge 只做「连接 pi/dsh 与 Claude Code 权威 skill 目录 + MCP」的桥；
> 开发门控、slop 清理、debug 审计全部集中在 ShipGate。

## 2. 目标

| # | 目标 | 可验证结果 |
|---|---|---|
| G1 | bridge 不再规划 / 安装门控 | `bridge plan` 的 pi/dsh 动作里不再出现 `kind: gate` |
| G2 | bridge 不再维护第二份 policy 真源 | 不再生成 `~/.config/agent-config-bridge/gate-policy.json` |
| G3 | 四维桥接不受影响 | skills / commands / rules-doc / MCP 计划与 apply 行为不变 |
| G4 | 旧产物与旧脚本诚实标注 | README 与 status 说明「门控已迁至 ShipGate」；续跑脚本标 deprecated 并指向 ShipGate 命令 |

## 3. 非目标

- 不删除 `bridge/gates/`：它是 ShipGate `assets/gates/` 的上游快照，本版本冻结保留，下一个大版本再删除。
- 不自动清理本机已装的门控目录与 policy 文件（门控自保护会拦；由用户亲手执行，ShipGate `doctor` 给出命令）。
- 不改 MCP 读取器（`scripts/install-dsh.js` 的 mcp 部分）、commands 插件、skills 链接逻辑。
- 不改 `never_touch` 清单。

## 4. 用户故事

1. 作为同时装了 ShipGate 的用户，我跑 `bridge apply` 不会再多装一份门控。
2. 作为维护者，我一眼能从 README 看清「bridge 管哪四维、ShipGate 管什么」。
3. 作为用户，我旧机器上残留的门控不会因为再跑一次 `bridge apply` 而复活。

## 5. 风险

| 风险 | 缓解 |
|---|---|
| 关闭 gate 会让已有用户失去门控 | ShipGate 已承接同一份产物；本机 `enforce-rules` 已装且 policy.js 更新。文档写明迁移路径 |
| `bridge/gates/` 冻结后与 ShipGate 版本漂移 | CHANGELOG 记录「权威源已迁至 ShipGate assets/gates」 |
| 续跑脚本被误用 | 脚本保留但打印 deprecation 提示，指向 `shipgate install --with-goal-mode` |
| 测试断言旧行为 | 全量 `node --test` 验证；仅调整真正断言「bridge 装门控」的用例 |
