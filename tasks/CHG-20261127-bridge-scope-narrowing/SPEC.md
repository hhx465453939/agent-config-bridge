---
change_id: CHG-20261127-bridge-scope-narrowing
version: 1
status: approved
prd_ref: PRD.md
supersedes: null
extends: CHG-20261124-gate-path-resolution
approved_by: damncheater
approved_at: 2026-11-27
---

# SPEC — bridge 收缩为纯桥

## 1. 门控维度关闭（功能性改动，唯一必要代码变更）

`bridge/lib/gates.js` 的 `planGateInstall` 已有早退：

```js
if (!manifest.gates || manifest.gates.supported === false) return [];
```

因此只需把 `bridge/targets/pi.json` 与 `bridge/targets/dsh.json` 的 `gates` 段改为：

```json
"gates": {
  "supported": false,
  "reason": "Hard gates moved to ShipGate (assets/gates + `shipgate policy`). agent-config-bridge keeps only skills / commands / rules-doc / MCP."
}
```

保留键而不是删键：`status` / `doctor` 仍能读到「为什么没有门控」，而不是把 harness 当成「能力缺失」。

## 2. `bridge/gates/` 冻结

- 目录保留，作为 ShipGate `assets/gates/` 的上游快照。
- 顶部新增 `DEPRECATED.md`，说明：权威源已迁至 ShipGate；本目录不再演进；下个大版本删除。
- 不删任何文件：`bridge/test/gate-*.test.js` 仍以它为被测对象，删除会造成大面积测试失效且无收益。

## 3. 续跑扩展脚本标注废弃

`scripts/install-pi-goal-mode.js`、`scripts/install-pi-auto-continue.js`：

- 保留（用户可能仍在用）。
- 脚本首行输出改为 deprecation 提示，指向 `shipgate install --with-goal-mode` / `--with-auto-continue`。
- README 对应小节标注「已迁至 ShipGate」。

## 4. status / plan 输出诚实化

`status` 对 pi/dsh 不再出现 `gate: ... installed` 行（因为 bridge 不再装）。若目标机器上仍有 `bridge/lib/gates.js` 历史产物，`status` 不应把它算成 bridge 的当前成果。

实现：`bridge/lib/api.js` / `status` 分支只读取 `manifest.gates.supported`；supported=false 时不渲染 gate 状态行。

## 5. 文档

- `README.md`「硬闸门」整节改为「已迁至 ShipGate」，保留历史说明与迁移命令。
- 新增「职责边界」表：四个维度归 bridge，门控 / slop / debug / 续跑归 ShipGate。

## 6. 里程碑

| M | 内容 | 独占文件 | 验收 |
|---|---|---|---|
| M1 | 关闭门控维度 | `bridge/targets/pi.json` `bridge/targets/dsh.json` | AC-1、AC-2 |
| M2 | 冻结标记 | `bridge/gates/DEPRECATED.md` | AC-3 |
| M3 | 脚本废弃提示 | `scripts/install-pi-goal-mode.js` `scripts/install-pi-auto-continue.js` | AC-4 |
| M4 | status/plan/verify 诚实化 | `bridge/lib/api.js`（如有必要） `bridge/lib/status.js` `bridge/lib/gates.js` `bridge/lib/manifest.js` `scripts/bootstrap.js` | AC-5、AC-9 |
| M5 | 文档 | `README.md` | AC-6 |
| M6 | 测试 | `bridge/test/*.test.js` | AC-7 |

## 7. 验收判据

- **AC-1** `node bridge/cli.js plan` 的输出里，pi 与 dsh 的动作 **不含** `kind: gate`。
- **AC-2** `bridge/targets/pi.json` 与 `dsh.json` 的 `gates.supported === false` 且含 `reason`。
- **AC-3** `bridge/gates/DEPRECATED.md` 存在，写明权威源已迁至 ShipGate。
- **AC-4** 运行 `node scripts/install-pi-goal-mode.js`（干跑）首屏出现 `已迁至 ShipGate` 或 `deprecated` 字样。
- **AC-5** `node bridge/cli.js status` 对 pi/dsh 不再输出 `gate ... installed` 作为 bridge 的成果。
- **AC-6** `README.md` 含「职责边界」表，且硬闸门节明确写「已迁至 ShipGate」。
- **AC-7** `node --test bridge/test/*.test.js` 全绿（允许按新行为调整断言，不允许删测试）。
- **AC-8** 冒烟：`node bridge/cli.js plan` 对 pi/dsh 仍正常列出 skills / commands / rules-doc / MCP 四维动作，未因门控关闭而整体失败。
- **AC-9** `scripts/bootstrap.js` 不再因「未声明 gates.extension_dir」而失败：仅有 `~/.pi` 的假机器上干跑退出码 0，且输出「门控已迁至 ShipGate」。
- **AC-10** `scripts/install-dsh.js --only gates` 不再 fail：输出「⏭ 硬门控已迁至 ShipGate」并以 0 退出（dsh 已存在时）。

## 8. DoR / DoD

- DoR：ShipGate 侧 `CHG-20261127-deploy-topology-consolidation` 已实现（承接方就位）。
- DoD：AC-1…AC-10 全绿；TRACEABILITY 填实测；README 与实现一致。
