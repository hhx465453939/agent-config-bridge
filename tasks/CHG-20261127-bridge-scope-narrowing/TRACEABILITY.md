# TRACEABILITY — bridge 收缩为纯桥

对应 CHG：`CHG-20261127-bridge-scope-narrowing` ｜ SPEC v1 ｜ PRD 已批准 ｜ 配套 ShipGate `CHG-20261127-deploy-topology-consolidation`

## 1. 需求 → 设计 → 里程碑 → 验收

| # | 目标 | SPEC 落点 | 里程碑 | 验收 | 验证证据 |
|---|---|---|---|---|---|
| G1 | bridge 不再规划/安装门控 | §1 | M1 | AC-1、AC-2 | `plan` 无 `kind: gate`；targets `supported:false` |
| G2 | 不再维护第二份 policy 真源 | §1、§4 | M1、M4 | AC-5 | status 不再报告 gate 成果 |
| G3 | 四维桥接不受影响 | §1 | M1 | AC-8 | plan 仍列出 skills/commands/rules-doc/MCP |
| G4 | 旧产物与旧脚本诚实标注 | §2、§3、§5 | M2、M3、M5 | AC-3、AC-4、AC-6 | DEPRECATED.md + 脚本提示 + README |

## 2. 里程碑 → 独占文件清单

| M | 独占文件 |
|---|---|
| M1 | `bridge/targets/pi.json` `bridge/targets/dsh.json` |
| M2 | `bridge/gates/DEPRECATED.md` |
| M3 | `scripts/install-pi-goal-mode.js` `scripts/install-pi-auto-continue.js` |
| M4 | `bridge/lib/api.js`（仅当 status 仍渲染 gate 行时） `scripts/bootstrap.js` |
| M5 | `README.md` |
| M6 | `bridge/test/*.test.js` |

## 3. 验收执行记录（实测填入，禁止预先勾选）

| AC | 命令 | 结果 | 时间 |
|---|---|---|---|
| AC-1 | `node bridge/cli.js plan` | ✅ 门控动作计数 0（`grep -c enforce-rules` = 0） | 2026-11-27 |
| AC-2 | 读 targets JSON | ✅ `pi`/`dsh` 均 `gates.supported: false` + `reason`；保留 `extension_dir/install_as` 供废弃脚本定位（规划器仍早退） | 2026-11-27 |
| AC-3 | `ls bridge/gates/DEPRECATED.md` | ✅ 存在，写明权威源已迁至 ShipGate + 四维职责边界 | 2026-11-27 |
| AC-4 | `node scripts/install-pi-goal-mode.js` | ✅ stderr 输出「⚠ deprecated：硬门控与续跑扩展已迁至 ShipGate」+ `shipgate install --with-goal-mode` | 2026-11-27 |
| AC-5 | `node bridge/cli.js status` | ✅ `gate : owned elsewhere — Hard gates moved to ShipGate …`（不再误报 installed） | 2026-11-27 |
| AC-6 | 读 README 职责边界表 | ✅ 新增「职责边界」表 + 「已迁至 ShipGate」横幅 + 迁移命令 | 2026-11-27 |
| AC-7 | `node --test bridge/test/*.test.js` | ✅ 360 pass / 0 fail（2 skipped 为既有）；门控引擎用例改为沙箱 fixture 启用，不依赖真实 targets | 2026-11-27 |
| AC-8 | `plan` 四维动作冒烟 | ✅ dsh `keep=50`（rules-doc/commands/MCP 照常）；pi 四维照常；无门控动作 | 2026-11-27 |
| AC-9 | `scripts/bootstrap.js` 假机器干跑 | ✅ 仅有 `~/.pi` 时 exit 0，输出「⏭ 门控已迁至 ShipGate（gates.supported=false），跳过门控产物校验」 | 2026-11-27 |
| AC-10 | `install-dsh.js --only gates` | ✅ 输出「⏭ 硬门控已迁至 ShipGate」并 exit 0（不再 fail） | 2026-11-27 |

## 4. 风险与备注

1. **本机残留门控不由 bridge 清理**：`~/.pi/agent/extensions/coding-gateways`、`~/.dsh/plugins/agent-config-gates`、`~/.config/agent-config-bridge/gate-policy.json` 的移走/删除受门控自保护拦截，必须由主人亲手执行。ShipGate `doctor` 会给出精确命令。
2. **ShipGate 已接管**：`assets/gates/` 与 `assets/pi-extensions/` 是新的权威源；`policy.js` 已比本仓库版本更新。
3. **只关规划，不删资产**：避免一次删掉 6 个 gate-* 测试的被测对象。
