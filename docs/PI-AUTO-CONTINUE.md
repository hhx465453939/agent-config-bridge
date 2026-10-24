# 可选能力：pi 长任务续跑（auto-continue）

> 默认**不安装**。这是一个 opt-in 部署项，只影响 `~/.pi/agent/extensions/`，不碰任何被桥接的共享维度。

## 为什么需要它

pi 的每一轮 assistant 回复结束，控制权都会交回用户 —— 这不是配置项，也关不掉，是对话协议的边界。
对「一个里程碑要连跑十几轮」的开发方式来说，每轮手动回车是纯损耗。

pi 的扩展 API 提供了唯一合法入口：`turn_end` 边界可以投递下一条指令。本扩展就是把这个入口封成开关。

## 安装

```bash
# 1) 干跑，先看要写哪个文件
node scripts/install-pi-auto-continue.js

# 2) 实际安装（目标已存在会先备份为 *.bak.<timestamp>）
node scripts/install-pi-auto-continue.js --apply

# 3) 在 pi 里 reload，然后开启
#    /reload
#    /auto on 40
```

装完后 pi 的扩展目录里会多一个 `auto-continue.ts`（路径取自 `bridge/targets/pi.json` 的 `gates.extension_dir`，脚本不猜路径）。

## 使用

| 命令 | 作用 |
|---|---|
| `/auto on 40` | 开启，最多连续 40 轮 |
| `/auto off` | 立即停止（本轮结束后不再续跑） |
| `/auto status` | 查看当前状态与剩余轮数 |

状态文件：`<项目>/.pi/auto-continue.json`（运行时产物，建议 gitignore；模板见 `.pi/auto-continue.example.json`）。

## 三重安全阀

1. 剩余轮数归零 → 自动关闭；
2. 目标文件出现 `state: DONE` → 自动关闭；
3. 助手输出 `<promise>COMPLETE</promise>` → 自动关闭。

另外硬上限 200 轮，避免真正的死循环。

## 实现要点（为什么不是简单循环）

`turn_end` 触发时 agent 仍处于处理中，直接 `sendUserMessage` 会抛：

```
Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.
```

所以必须带 `{ streamingBehavior: "followUp" }`，把下一条指令排队到本轮之后。这是本扩展唯一的技术难点，已固化在源码注释里。

## 卸载

```bash
rm ~/.pi/agent/extensions/auto-continue.ts
```

扩展是自包含单文件，没有任何其它副作用；删掉即回到原生行为。

## 与桥接的关系

- 不进入 `bridge/targets/*.json` 的 `managed` 清单 —— 它不属于「跟随 Claude Code」的共享维度；
- `gates.extension_dir` 只用于**定位**安装目录，不改写 pi 的其它扩展；
- `revoke pi` 不会删它（它不是桥接产物），需要按上面的卸载命令手动删。
