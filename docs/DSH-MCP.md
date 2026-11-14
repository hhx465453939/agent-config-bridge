# dsh 的 MCP：生成文档 + 读取器

dsh 是这组目标里唯一**没有用户级 MCP 声明文件**的 harness。它的 server 只能来自两处：

1. profile 组合里 `mcp-manager` 行的 `config.servers`（`~/.dsh/profiles/<profile>/cordis.patch.yml`）；
2. 插件在运行时调用 `ctx.mcpManager.register(name, entry)`。

第 1 条是**设置面**：dsh 的 GUI 会写它，清单里它是 `never_touch`。项目一旦去改它，就等于拿用户的配置赌一次格式（YAML 合并、注释、别人的行）。第 2 条是给插件用的，正好可以承载"桥接器产出的东西"。

所以这条链拆成两半，各管一件事：

| 一半 | 谁负责 | 产物 |
|---|---|---|
| 文档 | `bridge apply`（受管，快照可回滚） | `~/.dsh/agent-config-bridge/mcp.json` |
| 读取器 | `node scripts/install-dsh.js --only mcp --yes`（代码，装一次） | `~/.dsh/plugins/agent-config-mcp/` |

```
~/.claude.json  ──(bridge apply)──▶  ~/.dsh/agent-config-bridge/mcp.json
                                              │ 读取器轮询（~1s）
                                              ▼
                                 ctx.mcpManager.register(name, entry)
                                              │
                                              ▼
                          mcp__<server>__<tool> 进入模型工具列表
                          /mcp 可列出、可 restart
```

## 文档：Claude 形状，不是 dsh 形状

生成的 `mcp.json` 与给 pi 的完全同构（`{"mcpServers": {...}}`，stdio 用 `command/args/env/cwd`，HTTP 用 `url/headers`）。理由有二：

* 人类调试时看到的就是权威源的字段，不用在两套形状之间翻译；
* 形状转换只存在于读取器里一处（`translateServers`），它被单测覆盖，而不是散在 YAML 和文档里。

`mode 600`：Claude 的 `.claude.json` 里凭据是字面值，桥接器只做 `${VAR}` 展开，因此文档可能包含真实凭据。

## 读取器：只做三件事

1. **启动时**读文档、逐条 `register()`；
2. **变化时**（轮询 mtime）重建改过的条目、撤掉删掉的条目；没变的条目不动（重建会断开正在用的连接）；
3. **文档坏了时不动作**——半写、缺文件、JSON 非法都不撤现有舰队。做减法只能来自一份能解析的文档。

顺序上"先撤后建"是硬要求：manager 拒绝重复的 server 名。

读取器还会写一份运行时旁证：`~/.dsh/agent-config-bridge/mcp-status.json`，只有名字、状态、工具数、失败原因（截断），**不含凭据**。`/mcp` 读的是 manager，这份文件是给"没有 UI 的时候怎么知道它活着"用的。

## 安装与挂载

```bash
# 1) 装读取器代码（dsh 不会自动加载扩展目录，所以还要挂一行）
node scripts/install-dsh.js --only mcp --yes

# 2) 把脚本打印的那一段贴进 profile patch，保存即可（dsh 热重载）
- insert:
    - id: agent-config-mcp
      name: '../../plugins/agent-config-mcp/index.js'
```

相对路径是相对 patch 文件所在目录（`~/.dsh/profiles/<profile>/`），所以它指向 `~/.dsh/plugins/`。`scripts/install-dsh.js` 会检查这一行是否已经粘过，并单独报告"装了但没挂"。

文档本身由 `bridge apply` 管理：

```bash
node bridge/cli.js adopt dsh     # 首次：快照 + 写入文档
node bridge/cli.js apply         # 之后每次：Claude 那边改了什么就跟什么
```

## 验证

```bash
node bridge/cli.js status        # dsh: bridged，drift 应为 none
node bridge/cli.js doctor        # 0 error；gate 未挂载会有一条 WARN（预期）

cat ~/.dsh/agent-config-bridge/mcp-status.json
# registered=15, 每个 server 的 state=connected 与 toolCount
```

在会话里：`/mcp` 列出这些 server（来源 `plugin`），`/mcp restart <name>` 重连一个；工具名是 `mcp__<server>__<tool>`。

## 边界

* **不写 profile**：`.dsh/profiles` 在 `never_touch` 里，挂载行只能由人来粘（脚本负责打印与检查）。这是 dsh 的设计（插件必须被组合显式挂载），不是本项目的偷懒。
* **凭据是文档里的字面值（mode 600）**：`${credential:NAME}` 模板要求写 `~/.dsh/.credentials.yaml`，它同样是 `never_touch`。与 pi 的处理一致。
* **只支持 stdio / streamable-http**：dsh 的 manager 就这两种传输；其它形状会在 `skipped` 里报出来，不会静默消失。
* **改配置 ≈ 重连**：条目任何字段变化都会重建实例（manager 的语义），会有一次短暂的工具缺口。
* **dsh 的 `/mcp` 命令独立存在**：读取器只负责注册；命令来自 `dsh/commands/`（`--only commands`）。
