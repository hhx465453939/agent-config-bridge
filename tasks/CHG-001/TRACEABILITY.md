# TRACEABILITY — CHG-001（v2：opt-in + revoke）

> 每行 = `PRD 需求 → SPEC 章节 → 里程碑 → 验证命令 → 证据落点`。
> 证据列在对应里程碑完成时回填；未完成的填 `—`，不得预先填 ✅。

## 1. 需求 → 设计 → 里程碑 映射

| PRD 需求 | PRD 编号 | SPEC 章节 | 里程碑 | 验证命令 | 证据落点 | 状态 |
|---|---|---|---|---|---|---|
| 默认不动作（全 native） | G1 / C8 | §4.2、§3 D9 | M1 | `node bridge/cli.js status`（无状态文件时） | status 输出"全部 native" | 待实施 |
| 按 agent 显式选择 | G2 | §4.1、§4.2 | M2 | `node bridge/cli.js adopt <agent>` | state.json + 快照目录 | 待实施 |
| 可撤回 | G3 / C9 | §4.2、§3 D10 | M2 | `node bridge/cli.js revoke <agent>` | revoke 前后 md5 比对 | 待实施 |
| 只桥接共享维度 | G4 / C10 | §4.3、§3 D12 | M3 | 检查 `bridge/targets/*.json` 的 managed/never_touch | 清单 + doctor 无重叠报错 | 待实施 |
| 不误伤（清单外不动） | G5 | §4.3 | M3 | 未 adopt 端 md5 全量比对 | 比对报告 | 待实施 |
| 可回滚 | G6 | §4.9 | M3、M5 | `node bridge/cli.js rollback` | 回滚前后 md5 比对 | 待实施 |
| 可移植 | G7 | §4.7、M6 | M6 | 按 `docs/USAGE.md` 干净环境走查 | 走查清单 | 待实施 |
| 零泄露 | G8 | §4.5 | M1、M4、M6 | `bash scripts/scan-secrets.sh --history` | 扫描报告（0 命中） | 待实施 |
| 看清各 agent 状态 | US-001 | §4.1、§4.2 | M1 | `node bridge/cli.js status` | 输出 + 人工核对 | 待实施 |
| 选择跟随 Claude Code | US-002 | §4.1、§4.2 | M2 | `adopt` 前后 md5 全量比对 | 比对报告 + 快照清单 | 待实施 |
| 撤回恢复原生 | US-003 | §4.2 | M2 | `revoke` + 快照 md5 比对 | 演练记录 | 待实施 |
| 干跑审阅 | US-004 | §4.1 | M1、M3 | `plan` + mtime 快照 | 单测输出 | 待实施 |
| 一键同步 | US-005 | §4.3 | M3 | `apply` → `diff` | diff = 0 漂移 | 待实施 |
| MCP 跨格式 + 密钥外置 | US-006 | §4.4、§4.5 | M4 | `node --test tests/mcp.*`；`doctor --strict` | 单测输出 + 人工核对记录 | 待实施 |
| 自检与漂移报告 | US-007 | §4.8 | M5 | 制造漂移 → `doctor` 退出码非 0 | 回放记录 | 待实施 |
| 回滚 | US-008 | §4.9 | M3/M5 | `rollback` + md5 比对 | 演练记录 | 待实施 |
| 新机上机 | US-009 | §4.7 | M7 | 文档走查 | 走查清单 | 待实施 |
| 硬闸门：装/卸/幂等/漂移 | US-010 | §4.10、§3 D14-D16 | M5 | `node --test bridge/test/gates.test.js` | 单测输出 | 待实施 |
| 硬闸门：无机制的端如实报告 | US-010 | §4.10 | M5 | `status` 输出 | status 报告 | 待实施 |
| 未 adopt 端零改动 | SS1 / 度量#2 | §1.4 C8 | M2、M3 | 全程 md5 快照 | 比对报告 | 待实施 |
| 同步后 0 漂移 | SS2 | §4.1 | M3 | `diff` | 报告 | 待实施 |
| revoke 逐字节一致 | SS3 | §4.2 | M2 | md5 全量比对 | 演练记录 | 待实施 |
| 仓库脱敏 | SS4 | §4.5 | M1/M6 | `scan-secrets.sh --history` | 扫描报告 | 待实施 |
| 破坏性恢复 | SS5 | §4.9 | M5 | 删 bridged 端一个 skill → `apply` → 其他端 md5 不变 | 演练记录 | 待实施 |
| pi 侧 skill 生效（若 adopt pi） | SS6 | §4.3 | M6 | 抽样 5 个 `/skill:<name>` 可见 | 抽样记录 | 待实施 |
| 私有配置不被改动 | SS7 | §4.3、C10 | M2、M3 | 被 adopt 端 settings.json md5 比对 | 比对报告 | 待实施 |

## 2. 验收标准 → 证据矩阵

| 来源 | 验收项 | 类型 | 证据形式 |
|---|---|---|---|
| PRD §5 US-001 | `status` 不写盘、未装端显示"未检测到" | 自动化 | 单元测试 |
| PRD §5 US-002 | adopt 前落完整快照 | 自动化 | 快照目录 + manifest 校验 |
| PRD §5 US-002 | 仅对指定 agent 生效 | 自动化 | 其他端 md5 全量比对 |
| PRD §5 US-002 | 私有配置 md5 不变 | 自动化 | md5 比对 |
| PRD §5 US-002 | 冲突项逐条列出 | 自动化 | 输出断言 + 快照 |
| PRD §5 US-003 | revoke 后与快照逐字节一致 | 自动化 + 人工 | 单测（往返）+ 真机演练 |
| PRD §5 US-003 | 快照缺失时拒绝执行 | 自动化 | 单测（退出码 1） |
| PRD §5 US-004 | `plan` 不写盘 | 自动化 | mtime 快照 |
| PRD §5 US-004 | `plan` 输出稳定可 diff | 自动化 | 两次输出 diff 为空 |
| PRD §5 US-005 | 受管文件逐字节一致 | 自动化 | md5 全量比对 |
| PRD §5 US-005 | 覆盖前有备份 | 自动化 | 备份目录清单 |
| PRD §5 US-006 | 四种格式结构等价 | 自动化 | fixture 往返单测 |
| PRD §5 US-006 | 用户自有 MCP 条目保留 | 自动化 | 单测（关键反例用例） |
| PRD §5 US-006 | 产物权限 600 | 自动化 | `stat -c %a` 断言 |
| PRD §5 US-006 | 缺变量 fail-closed | 自动化 | 单测（退出码 1，无写入） |
| PRD §5 US-007 | 漂移时不静默通过 | 自动化 | 退出码断言 |
| PRD §5 US-008 | 回滚逐字节一致 | 自动化 + 人工 | 单测 + 真机演练 |
| PRD §5 US-009 | README 步骤可照抄 | 人工 | 走查清单 |
| PRD §5 US-010 | 闸门随 adopt 装上、随 revoke 卸载 | 自动化 | 沙箱整树快照对比 + 文件存在断言 |
| PRD §5 US-010 | 闸门安装幂等 | 自动化 | `diff` 断言 0 变更 |
| PRD §5 US-010 | 策略加载失败时放行而非卡死 | 自动化 | 单测（坏 JSON → ok=false） |
| PRD §5 US-010 | 拦截上限生效 | 自动化 | 单测（第 N+1 次放行） |
| PRD §5 US-010 | 不硬编码作者家目录 | 人工 + 脚本 | 敏感扫描（家目录路径模式） |
| PRD §9 | 默认 plan 变更数 = 0 | 自动化 | 集成测试 |
| PRD §9 | 新增 skill 到全端 ≤ 2 步 | 人工 | 演练记录 |
| SPEC §6 DoD | 六处文档一致 | 人工 + 脚本 | 文档比对清单 |
| SPEC §6 DoD | 未纳入项显式 accepted | 人工 | 本文件第 3 节 |

## 3. 明确接受的遗留（Accepted Residuals）

| 项 | 决定 | 依据 |
|---|---|---|
| **不默认接管任何 agent** | accepted（这是设计目标，不是妥协） | PRD §3 G1 |
| Claude `output-styles/` 不纳入 | accepted | 各目标端无对等概念（PRD §6） |
| Claude `hooks/` 不代管，仅报告 | accepted | 无通用对等物；pi 用 extensions 已另行管理 |
| pi `extensions/` 不代管 | accepted | pi 专有实现 |
| 不做跨机同步 | accepted | 单机工具定位（PRD §4） |
| 不支持 Windows 原生 | accepted | 目录约定与软链语义差异大（C7） |
| 既有 `sync-skill-pool.sh` / `deploy-skills.py` 不淘汰 | accepted | 用户资产，可能他域在用；淘汰由 iteration-manager 决策 |
| 源目录备份文件 / 平铺冗余 `.md` 不清理 | accepted | 桥接器显式忽略并报告，不擅自删用户文件 |
| 既有软链 `~/.agents/skills` 不自动移除 | accepted | 需用户显式授权（SPEC §9） |
| 快照只保留最近 5 份 | accepted | 磁盘占用可控（PRD §13 Q7 建议） |

## 4. 证据回填规则

1. 每条证据必须可**复现**：写明命令、执行时间、工作目录；
2. 自动化证据优先于人工描述；
3. 人工走查需留存清单文件（勾选状态）；
4. 一旦某项从"待实施"变为"通过"，须同时满足：命令实际执行 + 输出可查 + 无隐藏跳过；
5. **禁止预填通过**：未跑的命令不得标记 ✅（假绿比不测更危险）。

## 5. 真机端到端演练清单（M6 执行后回填）

| 步骤 | 命令 | 期望 | 实测 | 时间 |
|---|---|---|---|---|
| 1 | `status` | 报告全 native（首次使用） | | |
| 2 | `adopt <试点端>` | 落快照，置 bridged | | |
| 3 | `plan` | 列出将变更文件，无写入 | | |
| 4 | `apply` | 完成同步 | | |
| 5 | `diff` | 0 漂移 | | |
| 6 | `plan`（再跑一次） | 0 变更（幂等） | | |
| 7 | `md5sum` 未 adopt 端配置文件 | 与步骤 1 之前记录一致 | | |
| 8 | `md5sum` 被 adopt 端私有配置 | 与 adopt 前一致 | | |
| 9 | `revoke <试点端>` | 恢复原生 | | |
| 10 | `md5sum` 被 adopt 端受管文件 | 与 adopt 前快照一致 | | |

> 上表空白表示**尚未执行**；填了才算证据。
