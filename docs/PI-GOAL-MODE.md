# 可选能力：pi 长任务「目标驱动」（goal-mode）

> 默认**不安装**。这是一个 opt-in 部署项，只影响 `~/.pi/agent/extensions/`，不碰任何被桥接的共享维度。
>
> **与 [`PI-AUTO-CONTINUE.md`](PI-AUTO-CONTINUE.md) 二选一**，不要同时开启。

## 为什么需要它

pi 每一轮 assistant 回复结束，控制权都会交回用户 —— 这是对话协议的边界，不是配置项。
对「一个里程碑要连跑十几轮」的开发方式，每轮手动回车是纯损耗。

`auto-continue` 解决了"不停"，但它是**无轮数上限**的：只要模型不输出完成标记，就会一直续跑。
`goal-mode` 在同样的续跑能力上补了三道刹车，适合"给一句话目标，让它自己跑到完"：

| 能力 | auto-continue | goal-mode |
|---|---|---|
| 续跑边界 | `turn_end` | `agent_before_settle` |
| 轮数上限 | 无（`-1`） | 默认 400，可 `/goal max N` |
| 时长上限 | 无 | 默认 12h，可 `/goal hours N` |
| 空转检测 | 无 | 连续 3 轮零工具调用即停 |
| 完成信号 | `state: DONE` 或 `<promise>COMPLETE</promise>` | 模型调用 `goal_complete` 工具 |
| 用户中止 | `/auto off` | `/goal stop`，且按 Esc 中止时**不会**自动续跑 |
| 状态文件 | `.pi/auto-continue.json` | `.pi/goal-state.json` |

## 安装

```bash
# 1) 干跑，先看要写哪个文件
node scripts/install-pi-goal-mode.js

# 2) 实际安装（目标已存在会先备份为 *.bak.<timestamp>）
node scripts/install-pi-goal-mode.js --apply

# 3) 在 pi 里 reload，然后启动一个目标
#    /reload
#    /goal 把 xxx 项目从 A 做到 B，验收标准是 C
```

装完后 pi 的扩展目录里会多一个 `goal-mode.ts`（路径取自 `bridge/targets/pi.json` 的 `gates.extension_dir`，脚本不猜路径）。

> **如果你之前手工装过目录形式 `~/.pi/agent/extensions/goal-mode/index.ts`**，先删掉它再跑安装脚本。
> pi 会同时加载目录版和单文件版，两个 `agent_before_settle` handler 会重复续跑。安装脚本检测到目录版时会直接拒绝写盘。

## 使用

| 命令 | 作用 |
|---|---|
| `/goal <任务描述>` | 启动目标模式，立刻把目标发给 agent |
| `/goal` 或 `/goal status` | 查看状态、轮次、已运行时长、最近停止原因 |
| `/goal done` | 手动标记完成，停止续跑 |
| `/goal stop` | 立即停止（不标记完成） |
| `/goal max <n>` | 最大续跑轮数（默认 400） |
| `/goal hours <n>` | 最长运行小时数（默认 12） |

状态文件：`<项目>/.pi/goal-state.json`（运行时产物，建议 gitignore）。

## 停机条件

按优先级：

1. 用户按 Esc / Ctrl-C 中止 → **不续跑**（`outcome === "aborted"` 时直接停）；
2. `/goal stop` 或 `/goal done`；
3. 模型调用 `goal_complete` 工具；
4. 达到最大轮数（默认 400）；
5. 达到最长运行时长（默认 12 小时）；
6. 连续 3 轮没有任何工具调用（判定空转）。

进程重启后不会自动接管旧目标：`active` 状态会被改写成 `stopped`，需要用户用 `/goal` 重新确认。

## 实现要点

**坑一：不要在 `turn_end` 里调 `sendUserMessage`。** 此时 agent 仍在处理中，会抛：

```
Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.
```

**正确做法**是走 boundary 机制：

```ts
return {
  continue: true,
  entries: [...event.entries, { type: "custom_message", customType: "goal-mode-continue", content, display: false }],
};
```

**坑二：不要重复注册扩展。** `.pi/extensions/` 本身就是 pi 的项目级自动发现目录；再在 `.pi/settings.json` 的 `extensions` 里写一遍，同一个文件会被加载两次。

**坑三：`goal_complete` 的 typebox schema 由 pi 运行时提供。** `import { Type } from "typebox"` 不会给本仓库新增依赖；`auto-continue.ts` 只 import `@earendil-works/pi-coding-agent` 也是同样的性质。

## 卸载

```bash
rm ~/.pi/agent/extensions/goal-mode.ts
```

扩展是自包含单文件，没有任何其它副作用；删掉即回到原生行为。

## 与桥接的关系

- 不进入 `bridge/targets/*.json` 的 `managed` 清单 —— 它不属于「跟随 Claude Code」的共享维度；
- `gates.extension_dir` 只用于**定位**安装目录，不改写 pi 的其它扩展；
- `revoke pi` 不会删它（它不是桥接产物），需要按上面的卸载命令手动删。
