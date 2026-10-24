# 可选能力：pi 长任务续跑（auto-continue）

> 默认**不安装**。这是一个 opt-in 部署项，只影响 `~/.pi/agent/extensions/`，不碰任何被桥接的共享维度。

## 为什么需要它

pi 的每一轮 assistant 回复结束，控制权都会交回用户 —— 这不是配置项，也关不掉，是对话协议的边界。
对「一个里程碑要连跑十几轮」的开发方式来说，每轮手动回车是纯损耗。

pi 的扩展 API 提供了唯一合法入口：`turn_end` 边界可以追加一条输入并请求继续。本扩展就是把这个入口封成开关。

## 安装

```bash
# 1) 干跑，先看要写哪个文件
node scripts/install-pi-auto-continue.js

# 2) 实际安装（目标已存在会先备份为 *.bak.<timestamp>）
node scripts/install-pi-auto-continue.js --apply

# 3) 在 pi 里 reload，然后开启（不限额，跑到完成）
#    /reload
#    /auto on
```

装完后 pi 的扩展目录里会多一个 `auto-continue.ts`（路径取自 `bridge/targets/pi.json` 的 `gates.extension_dir`，脚本不猜路径）。

## 使用

| 命令 | 作用 |
|---|---|
| `/auto on` | 开启，**不限轮数**，跑到 `state: DONE` 或 `<promise>COMPLETE</promise>` |
| `/auto on 20` | 可选：只再续跑 20 轮（`-1` 等价于不限） |
| `/auto off` | 立即停止 |
| `/auto status` | 查看状态与剩余轮数（`∞` = 不限） |

状态文件：`<项目>/.pi/auto-continue.json`（运行时产物，建议 gitignore；模板见 `.pi/auto-continue.example.json`）。

## 停机条件（只有三个，**没有轮数上限**）

1. `/auto off`；
2. 目标文件出现 `state: DONE`；
3. 助手输出 `<promise>COMPLETE</promise>`。

`remaining` 只是可选配额：`-1`（默认）= 不限额，正数 = 最多再续跑 N 轮，`0` = 已停。不存在「40 轮后自动停」这种默认值。

## 实现要点（两个坑）

**坑一：不要在 `turn_end` 里调 `sendUserMessage`。** 此时 agent 仍在处理中，会抛：

```
Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.
```

**正确做法**是走 boundary 机制：返回

```ts
return { continue: true, entries: [{ type: "custom_message", customType: "auto-continue", content: prompt, display: false }] }
```

让 pi 在本轮结束后把这条输入并入下一轮。这样既不碰「streaming 中不能发消息」的限制，也不依赖内部排队语义。

**坑二：不要重复注册扩展。** `.pi/extensions/` 本身就是 pi 的项目级自动发现目录；再在 `.pi/settings.json` 的 `extensions` 里写一遍，同一个文件会被加载两次，两个 `turn_end` handler 同时续跑。

## 卸载

```bash
rm ~/.pi/agent/extensions/auto-continue.ts
```

扩展是自包含单文件，没有任何其它副作用；删掉即回到原生行为。

## 与桥接的关系

- 不进入 `bridge/targets/*.json` 的 `managed` 清单 —— 它不属于「跟随 Claude Code」的共享维度；
- `gates.extension_dir` 只用于**定位**安装目录，不改写 pi 的其它扩展；
- `revoke pi` 不会删它（它不是桥接产物），需要按上面的卸载命令手动删。
