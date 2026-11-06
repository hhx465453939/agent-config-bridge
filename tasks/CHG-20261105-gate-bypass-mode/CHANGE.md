---
change_id: CHG-20261105-gate-bypass-mode
status: approved
---

# CHANGE · 改了什么、为什么

## 根因（不是「配少了」，是破坏性门控缺一个模式维）

### R-1 破坏性门控只有「单个动作该不该放行」，没有「此刻还要不要问」这一维

ADR-012 v2 把破坏性操作拆成两层：

```
guardrail（不可恢复，不可授权）
permission（七类 × allow/confirm/deny）
```

两层回答的都是**单个动作**该不该放行。真实故障是**时序**的：

```
彻夜运行的长任务
  └─ 第 3 小时命中一次 confirm 档
       ├─ 有 UI：弹窗 → 等人 → 人睡了 → 整夜卡在弹窗上
       └─ 无 UI：放行（ADR-012 已修）
```

交互式长任务（人开着会话跑一夜）是**有 UI** 的那一支，ADR-012 的「无 UI 自动放行」救不了。
`/gate grant <类别>` 能一类一类放开，但要预判会撞哪几类，漏一个就再卡一次。

### R-2 「全部门控静音」不是解法，用户明确否掉了

最省事的实现是「bypass = 关掉整个门控」。这会连带静音图谱优先、思考前置、CHG 契约、
AI4S、密钥与越界写入——**那些不是「点烦了的询问」，是门控存在的理由**。
因为凌晨不想点删除确认而静音它们，是拿一个烦人问题换一个更糟的盲区。

用户原话：「就是这种破坏性指令可以 bypass 和拒绝之间分挡位，**其他的都不牵扯**」。

### R-3 缺了它，用户的实际行为是卸载门控

一个会在半夜把人叫起来的门控，最终结局是被 `revoke` 掉——那时连红线和研究规则也没了。

## 改了什么

### 1. 新增 `config.destructive_mode`（`enforce` | `bypass`），默认 `enforce`

**作用域只有 `no-destructive-bash`**：

| 检查 | enforce | bypass |
|---|---|---|
| 红线部分（删 `$HOME`/cwd/含 `..`/顶层目录/git 根、磁盘格式化、裸设备写入、关机重启） | 拦 | **仍拦** |
| 权限部分（七类 × allow/confirm/deny） | 按档位 | **全放行** |
| `no-self-grant` | 拦 | **仍拦** |
| 图谱 / 思考 / 契约 / secret / 越界写入 / no-blind-retry / AI4S / no-slack / reminder | 按策略 | **完全不变** |

实现上 `shouldBlock` 的检查循环**没有任何**按模式跳过的分支；bypass 只在
`no-destructive-bash` 内部、红线早返回**之后**生效：

```js
if (finding.severity === 'high') return { code: 'DESTRUCTIVE_BASH', ... };  // 先
if (isDestructiveBypass(policy.config, deps?.state)) return null;           // 后
```

### 2. `no-self-grant` 扩到保护模式开关

原来只拦「内容含 `destructive_grants`」。若只加 `destructive_mode` 而不扩这条，
agent 一次 `write` 就把自己的破坏性权限层永久、全局地关掉——比 `grant db-ddl` 严重一个量级。
内容判据改为 `destructive_grants|destructive_mode`；shell 分支原本就是「写这两个文件即拦」。

### 3. `/gate mode` —— 用户亲手切，可自动到期

```
/gate mode                     查看当前模式；有 UI 时弹选择器
/gate mode bypass              全局 bypass，持久（写机器本地 gate-policy.json）
/gate mode bypass 8h           全局 bypass，8 小时后自动回 enforce（s/m/h/d）
/gate mode enforce             全局 enforce
/gate mode bypass session      仅本会话 bypass（不写盘，重开会话即失效）
/gate mode enforce session     仅本会话强制 enforce（覆盖全局）
```

`destructive_mode_until`（epoch ms，0=不过期）是「彻夜任务」的正确答案：
晚上 `8h`，早上自动收紧，不需要记得回来关。

### 4. 会话级覆盖的优先级

```
state.destructiveMode（/gate mode … session）> config.destructive_mode（全局）
全局 bypass 且 destructive_mode_until 已过 → enforce
```

与 ADR-012 的「收紧赢过放松」**不同**，这里会话覆盖双向都赢。理由写进 ADR-013：
类别授权是**权限**（agent 可能诱导用户点弹窗），模式开关是**用户亲手敲的 slash 命令**
（agent 无法调用 `registerCommand` 注册的命令），威胁模型不同。

### 5. 可见性

- `session_start` 时 `notify` + `stderr` 各一条：模式、来源、剩余时间、
  「只影响破坏性指令」「红线仍拦」「其他规则不受影响」；
- `/gate list` / `/gate mode` 首行永远显示当前生效模式。

### 6. dsh 端

无命令通道、无 UI。模式从 `policy.json` / 机器本地 override 读，`apply` 后生效；
启动时若处于 bypass，`logger.warn` + stderr 各一行。
顺带修掉 `bridge/gates/dsh/index.js` 缺失的 `readFileSync` 导入
（`realFs.readText` 会抛 `ReferenceError`，被 AI4S 的脚本检查吞成 fail-open）。

## 不做

- 不做「按命令正则白名单」：ADR-012 方案 C 的变体，正则本身成为新风险面。
- 不做「自动检测用户不在场」：无法可靠判定，制造虚假安全感。
- 不把 bypass 默认打开：默认必须最严格。
- 不让 bypass 影响破坏性命令以外的任何规则：见 R-2。
