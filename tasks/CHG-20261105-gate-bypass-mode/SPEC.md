---
change_id: CHG-20261105-gate-bypass-mode
version: 2
status: approved
prd_ref: PRD.md
created: 2026-11-05
owner: pi
---

# SPEC-20261105 · 破坏性指令门控的模式（enforce / bypass）

## 1. 目标（可判定终态）

1. **配置键**：`DEFAULT_CONFIG.destructive_mode = 'enforce'`、`DEFAULT_CONFIG.destructive_mode_until = 0`。
   `DESTRUCTIVE_MODES = ['enforce', 'bypass']` 导出；`normalizePolicy` 与 `applyMachineOverride`
   对两个键做白名单/数值归一并写回 `config`。未知取值一律落回 `enforce` / `0`
   （不得抛错、不得让门控消失）。
2. **判定函数**：导出 `effectiveDestructiveMode(config, state, now)` 与
   `isDestructiveBypass(config, state, now)`，规则为
   ```
   state.destructiveMode ∈ DESTRUCTIVE_MODES -> 用它（会话覆盖，双向都赢）
   config.destructive_mode === 'bypass'
     且 destructive_mode_until > 0 且 now >= 它 -> 'enforce'（到期）
     -> 'bypass'
   其余                                       -> 'enforce'
   ```
   另导出 `destructiveModeRemainingMs(config, now)`（未设置/不过期返回 `null`）。
3. **作用域只有 `no-destructive-bash`**：`shouldBlock` 的检查循环**不得**出现任何按模式跳过
   检查的分支。即 bypass 下 `no-write-outside`、`no-secret-write`、`graph-before-read`、
   `bash-graph-before-read`、`index-freshness-before-read`、`think-before-write`、
   `chg-contract-before-edit`、`no-blind-retry` 以及 AI4S/W1·W2·W4、`reminderFor`、
   pi 的 `turn_end` 全部与 enforce 逐字相同。
4. **红线不可绕**：`no-destructive-bash` 对 `finding.severity === 'high'` 的早返回必须在
   bypass 判定**之前**。任何授权、任何模式都无法让删 `$HOME` / cwd / 含 `..` / 顶层目录 /
   git 根 / 磁盘格式化 / 裸设备写入 / 关机重启通过。
5. **自我提权保护**：`no-self-grant` 的 write 分支内容判据由 `/destructive_grants/` 扩为
   `/destructive_grants|destructive_mode/`；shell 分支判据不变（写这两个文件即拦）。
6. **会话状态**：`newSessionState()` 增加 `destructiveMode: null`；pi adapter 的
   `session_start` 重置它。
7. **pi 命令**：`/gate` 新增 `mode` 子命令
   ```
   /gate mode                        报告 + （有 UI 时）选择器
   /gate mode bypass [时长]          全局持久；时长写法 30m / 8h / 2d / 90s（裸数字按小时）
   /gate mode enforce                全局持久，清 destructive_mode_until
   /gate mode bypass session         仅本会话（不写盘）
   /gate mode enforce session        仅本会话
   ```
   时长解析失败 → 提示正确写法且**不写盘**；会话覆盖 + 时长同时出现 → 拒绝并提示。
8. **可观察性**：
   - `session_start`：`state.destructiveMode` 重置；若生效模式为 bypass，
     `ctx.ui.notify(..., 'warn')` + `process.stderr` 各一条，内容含模式、来源（全局/本会话）、
     剩余时间、「只影响破坏性指令」「红线仍拦」「其他规则不受影响」。
   - `/gate list` 与 `/gate mode` 首行显示生效模式。
9. **dsh**：启动时若 `isDestructiveBypass(policy.config, state)`，`ctx.logger?.warn?.()` +
   stderr 各一行，文案同样限定作用域。顺带修复缺失的 `readFileSync` 导入。
10. **两端 policy.json**：`bridge/gates/{pi,dsh}/policy.json` 的 `config` 显式声明
    `destructive_mode: "enforce"`、`destructive_mode_until: 0`。
11. **安装目录 README**：`bridge/lib/gates.js` 的 `readme()` 增加
    「Destructive-command mode: enforce / bypass」一节，必须写明
    affected / still blocked / unaffected 三行。
12. **文档**：`docs/ADR/013-gate-bypass-mode.md`；README 的门控段落补 `/gate mode`。

## 2. 架构与债务

- 遵守 ADR-003：`policy.js` 不含 UI、不写盘（除既有的只读 `applyMachineOverride`）；
  `/gate mode` 的写盘、时长解析全部在 `bridge/gates/pi/index.js`。
- `shouldBlock` 签名与返回形状**不变**，新增行为只取决于入参 `policy.config` 与 `state`，
  因此 dsh 与既有测试桩不需要改调用方式。
- 已知债务（不在本 CHG）：`policy.js` 已超 3300 行；`/gate` handler 变长，
  若继续加子命令应拆成 `gates/pi/commands/`。

## 3. 验收（AC）

模式与档位（`bridge/test/gate-bypass.test.js`）：

- AC-1 默认模式是 enforce：`DEFAULT_CONFIG.destructive_mode === 'enforce'`。
- AC-2 enforce 下 `rm -f <普通文件>` 仍返回 `confirm`（不回归 ADR-012）。
- AC-3 `destructive_mode: 'bypass'` 下同一命令返回 `block:false, confirm:false`。
- AC-4 bypass 下红线仍拦：`rm -rf $HOME` / `rm -rf .` / `rm -rf /tmp` / `a/../b` /
  `mkfs.ext4` / `shutdown` → `block:true, code:DESTRUCTIVE_BASH`；全类别 grant 也一样。
- AC-5 bypass 下 `deny` 类别放行：`drop database prod` → 不拦。
- AC-6 bypass 下 `no-self-grant` 仍拦：写含 `destructive_mode` 的内容 → `GATE_SELF_GRANT`。
- AC-7 同一文件写不含两个键的内容 → 仍放行（不锁死整文件）。
- AC-8 **其他规则不受影响**：`graph-before-read` 在 bypass 下仍拦截普通 `read`。
- AC-9 **reminder 不受影响**：bypass 下 `reminderFor` 仍返回 reminder 文本。
- AC-10 **turn_end 不受影响**：bypass 下 no-slack 仍返回 `continue: true`。
- AC-11 到期：`destructive_mode_until` 在过去 → enforce（confirm 回来）。
- AC-12 到期：`destructive_mode_until` 在未来 → 仍 bypass；`0` → 不过期。
- AC-13 会话覆盖：`state.destructiveMode='bypass'` + 全局 enforce → bypass；
  `'enforce'` + 全局 bypass → enforce。
- AC-14 归一化：`destructive_mode:'BOGUS'` / `destructive_mode_until:'abc'` → `enforce` / `0`。
- AC-15 时长解析：`90s / 30m / 8h / 2d / 8` 正确，`0h / tomorrow` 返回 null。

命令与安装：

- AC-16 `/gate mode bypass` 写机器本地 `gate-policy.json` 的 `config.destructive_mode`，
  随后 `applyMachineOverride` 立即生效。
- AC-17 `/gate mode bypass 30m` 的 `destructive_mode_until` 落在 `now+30m±5s`；
  `/gate mode enforce` 把 `destructive_mode` 归零为 enforce 且 `_until` 清为 0。
- AC-18 `/gate mode bypass session` 不写盘、只改 `state.destructiveMode`；
  `/gate mode enforce`（全局）清掉会话覆盖；非法时长不写盘。
- AC-19 `/gate list` 首行含模式；`session_start` 在 bypass 下向 stderr 写一条含「红线」的告警。
- AC-20 dsh 从机器本地 override 读到 bypass 并告警；bypass 下权限档被 delegate，
  `rm -rf .` 仍 deny。两端 policy.json 声明 `enforce`。

回归：`node --test` 全绿、`node --check bridge/cli.js` 通过、`bash scripts/scan-secrets.sh` 无命中。
