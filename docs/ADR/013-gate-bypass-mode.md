# ADR-013 — 破坏性指令门控的模式：enforce / bypass

- 状态：已采纳
- 日期：2026-11-05
- 关联：CHG-20261105-gate-bypass-mode、ADR-012（破坏性操作两层模型）、ADR-003（策略层与适配层分离）

## 背景

ADR-012 把破坏性操作拆成 guardrail（不可恢复，不可授权）与 permission（七类 × 三档），
回答了「**这个动作**该不该放行」。它没有回答「**此刻**还要不要问破坏性命令」。

真实故障是时序性的：交互式会话里跑通宵任务，第 N 小时命中一次 `confirm`，弹窗等人，
人睡了，整夜卡住。已有手段都救不了：

| 手段 | 缺口 |
|---|---|
| 弹窗「本会话允许这一类」 | 一次一个类别，七类要撞七次，每个会话重来 |
| `/gate grant <类别>` | 需要预判会撞哪几类；漏一个就再卡一次 |
| `destructive_confirm_mode: false` | 方向反了（更紧），只作用于 confirm 档 |
| 无 UI 自动放行 | 用户的会话**有 UI**，走不到 |
| `revoke` 掉门控 | 连红线、连同图谱/契约/密钥规则一起没了 |

## 决策

新增 `config.destructive_mode`：`enforce`（默认）| `bypass`。

### 作用域刻意限定为 `no-destructive-bash`

用户的要求是「**破坏性指令**可以 bypass 和拒绝之间分挡位，其他的都不牵扯」。
这条边界就是这个 ADR 的核心，不是实现细节：

| 检查 | enforce | bypass |
|---|---|---|
| `no-destructive-bash` 红线部分（删 `$HOME` / cwd / 含 `..` / 顶层目录 / git 根、磁盘格式化、裸设备写入、关机重启） | 拦 | **仍拦** |
| `no-destructive-bash` 权限部分（七类 × allow/confirm/deny） | 按档位 | **全放行**（不弹窗、不拒绝） |
| `no-self-grant` | 拦 | **仍拦** |
| 图谱优先 / 思考前置 / CHG 契约 / secret / 越界写入 / no-blind-retry / AI4S W1·W2·W4 / 轮末 no-slack / 每轮 reminder | 按策略 | **完全不变，照旧执行** |

理由：那些规则不是「用户点烦了的询问」，它们是门控存在的理由——「先查图谱」「先读约定」
「先写 Worklog」不是打扰，是纪律。因为凌晨三点不想点删除确认而把它们一起静音，
是拿一个烦人问题换一个更糟的盲区。**一个开关只解决它命名的那个问题。**

所以实现上 bypass 判定的位置只有一处，在权限层里：

```js
// no-destructive-bash 内部
if (finding.severity === 'high') return { code: 'DESTRUCTIVE_BASH', ... };  // 红线，先
if (isDestructiveBypass(policy.config, deps?.state)) return null;           // 权限层，后
```

`shouldBlock` 的检查循环**没有**任何按模式跳过的分支——别的规则连「知道自己被 bypass 了」都做不到。

### 为什么 `no-self-grant` 必须保护这个开关

`destructive_mode` 与此前的 `destructive_grants` 住在同两个文件里
（`~/.config/agent-config-bridge/gate-policy.json`、安装版 `policy.json`）。
若 agent 能写它，一次 `write` 就把自己的破坏性权限层永久、全局地关掉——
比 `grant db-ddl` 严重一个量级，因为它不会过期、不需要撞类别。

因此 `no-self-grant` 的 write 分支内容判据从 `destructive_grants` 扩为
`destructive_grants|destructive_mode`；shell 分支不变（写这两个文件即拦，与内容无关）。

代价：agent 无法帮用户改这个文件。接受——它本来就不该能改。

### 会话覆盖双向都赢（与 ADR-012 的不对称优先级不同）

ADR-012 定的是「收紧赢过放松」，理由是：agent 可能通过对话诱导用户点一次弹窗授权，
于是会话授权不该推翻永久 `deny`。

模式开关的威胁模型不同：`/gate` 是 `registerCommand` 注册的 **slash 命令，只有用户能敲**，
agent 无法调用。所以 `state.destructiveMode`（`/gate mode … session`）可以双向覆盖全局：

```
state.destructiveMode 存在 -> 用它
否则 -> 全局 destructive_mode（到期则 enforce）
```

这条差异是刻意的，不是遗漏。若将来某个宿主允许 agent 触发命令，这条必须重新评估。

### `destructive_mode_until`：到期比记住更可靠

```
/gate mode bypass 8h
```

晚上设一次，早上自动回 enforce。人不会记得回来关开关，而一个忘了关的永久 bypass
是慢性的洞。到期判定只在读配置时做（不写盘、不需要定时器）：

```js
if (until > 0 && now >= until) return 'enforce';
```

### 为什么不用类别或 `checks` 表达

- 加第八个类别 `all-destructive`：类别是权限，`deny` 档仍会硬拦；也无法表达到期。
- 把 `checks` 置空：那是关掉整个门控，正是本 ADR 要避免的——用户明确要求「其他不牵扯」。

## 端能力差异

| 端 | 切换模式 | 生效 |
|---|---|---|
| pi | `/gate mode …`（含 UI 选择器） | 立即（写机器本地 override，adapter 已 `applyMachineOverride`） |
| pi（无 UI） | 同上，命令仍可敲 | 立即 |
| dsh | 无命令通道 | 改 `policy.json` / 机器本地 override 后由 adapter 启动时读取；启动写一行告警 |

dsh 的 `/gate` 缺失是既有边界（ADR-012 已知边界 6），本 ADR 不改变它。

## 可见性：静默的 bypass 也是问题

bypass 一旦安静，用户会以为授权档位还在生效。因此：

1. `session_start`：notify + stderr 一条，含模式、来源（全局/本会话）、剩余时间、
   「只影响破坏性指令」「红线仍拦」；
2. `/gate list` 与 `/gate mode` 首行永远是生效模式；
3. 每轮 reminder 不变——因为它们本来就不归这个开关管。

## 后果

正向

- 通宵任务不再被删除确认卡死；`8h` 到期自动收紧。
- 红线一条没松，`no-self-grant` 一条没松，**其他规则一条没动**。
- 可一键回退（`/gate mode enforce`）。
- 不需要为了跑通宵而 `revoke` 整个门控。

负向 / 需接受

- bypass 期间 `db-ddl` 这类默认 `deny` 的类别也放行——这就是用户要的「破坏性指令不分挡」。
- dsh 端无法在会话内切换模式。
- 若用户同时被图谱/契约规则拦住，bypass 不解决那个问题（按设计，那不是它的事）。

## 已知边界

1. **bypass 只对 `no-destructive-bash` 生效**：将来若新增第二个破坏性检查，
   必须显式让它调用 `isDestructiveBypass`，否则它会在 bypass 下继续拦——
   这个「默认不放过」的方向是刻意的。
2. **机器本地文件仍是用户手改的唯一入口**：agent 写这两个文件会 `GATE_SELF_GRANT`。
3. **到期不做后台清零**：`destructive_mode_until` 过期后文件里仍写着 `bypass`，
   只是判定为 enforce。下次 `/gate mode` 会显示「已到期」。
