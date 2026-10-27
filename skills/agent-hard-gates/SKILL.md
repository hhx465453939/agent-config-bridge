---
name: agent-hard-gates
description: 当需要在新宿主机部署/审计 AI 编码 agent 的「硬门控」（动脑子、codebase 图谱优先、不偷懒），或修改 ~/.pi/agent/extensions/enforce-rules 的规则时使用。覆盖 Windows/Linux/macOS 的识别、部署、验证与扩展。
---

# Agent 硬门控（可移植版）

规则文档是**建议**；本技能解决的是「模型决定不照做时怎么办」。
实现只有一份规则引擎，各 harness 的适配层很薄；配置与部署由 `agent-config-bridge` 管理。

## 三条铁律与机器判据

| 铁律 | 机器强制点 | 是否每轮生效 |
|---|---|---|
| **动脑子** | 改已存在文件前必须有本会话读取证据或图谱点名；改代码前必须读项目约定；有 `tasks/CHG-*` 时必须先读 CHG 契约；破坏性命令直接拒绝；同一失败命令原样重试第 3 次拦截 | 工具调用时 |
| **codebase 优先** | `read` 源码前必须有**有内容**的图谱结果；`bash`/PowerShell 的 `cat`/`grep -r`/`git show`/`find -exec`/`Get-Content` 同样受管；空结果不算证据；文件比最近一次索引刷新新时先重索引 | 工具调用时 |
| **不偷懒** | `turn_end` 扫描助手最终文本：出现「我稍后再补 / 后续再做 / 先不实现」等第一人称拖延承诺时，强制继续一轮（有次数上限） | **每轮结束时** |

关键区分：前两条是**工具级**门控，第三条是**轮次级**门控。只挂 `tool_call` 的闸门管不住「不动手、只许诺」。

## 部署（Windows / Linux / macOS 同一套命令）

前置：Node ≥ 20；已安装 pi（`~/.pi` 存在）。

```bash
git clone <仓库地址> ~/Development/agent-config-bridge
cd ~/Development/agent-config-bridge

# 1) 只看计划，不写盘
node scripts/bootstrap.js

# 2) 确认后执行：adopt pi → apply → 校验门控 → 安装本技能
node scripts/bootstrap.js --yes

# 3) 让 pi 重新加载（任选）
#    重启 pi，或在 pi 里执行 /reload
```

`bootstrap` 做四件事：
1. 探测 `~/.pi`，缺失即报错退出（不静默跳过）；
2. 未桥接则 `adopt pi`（先快照），随后 `apply`；
3. 校验 `~/.pi/agent/extensions/enforce-rules/policy.json` 存在且 `checks` 含 `graph-before-read`；
4. 安装本技能到 `~/.claude/skills/agent-hard-gates/`（pi 通过 `~/.agents/skills` 链接共享同一份）。

### 机器本地作用域（可选但推荐）

公共仓库不写死任何人的路径。需要把**非 git 目录**（脚本、MCP 源码、技能目录）也纳入门控时，在本机创建：

`~/.config/agent-config-bridge/gate-policy.json`

```json
{
  "config": {
    "project_roots": [
      "<你的开发根目录，绝对路径>",
      "<另一个开发根目录>"
    ]
  }
}
```

只允许覆盖 `config`；`checks` 与规则文本仍由仓库拥有。文件不存在时行为与旧版一致。

## 验证：门控真的在拦吗

三条都能**变红**，缺一不可：

```bash
# 1) 单元测试（含 v4 的 TTL / 索引证据 / 上限窗口 / no-slack / PowerShell）
node --test

# 2) 在 pi 里故意违规：直接读一个 git 仓库内的源码文件而不查图谱
#    期望：被 Layer 1 拦截（GRAPH_FIRST）

# 3) 在 pi 里回复一句「这个我稍后再补」，且本轮不调用任何工具
#    期望：被轮次级拦截，强制继续一轮
```

若第 2 条没被拦：检查 `~/.pi/agent/extensions/enforce-rules/` 是否在位、`/reload` 是否执行、`policy.json` 是否可解析。
若第 3 条没被拦：确认 `policy.json` 的 `config.slack_check` 为 `true` 且 `slack_max_continues > 0`。

## 规则引擎与扩展点

```
bridge/gates/
  policy.js     纯逻辑：不依赖任何 harness，可离线单测
  pi/index.js   pi 适配：tool_call / tool_result / turn_end / context
  dsh/index.js  DeepSeek Harness 适配（无结果与轮次钩子）
```

新增一个检查项：
1. 在 `policy.js` 的 `CHECKS` 里加纯函数（返回 `{code, reason}` 或 `null`）；
2. 在 `policy.json` 的 `checks` 数组里登记（顺序即级联顺序）；
3. 补一条**能红**的测试（写清破坏方式）；
4. 若决定它属于安全底线，加入 `HARD_CHECKS`。

新增一个 harness：只写适配层，把原生事件翻译成 `{action, path, command, content, shell}`，规则不动。

## 红线与坑

- **fail-closed 只给安全**：凭据写入、越界写入、破坏性命令永远生效；策略文件损坏时降级为这三项并显式告警，不让门控静默消失。
- **研究规则有上限**：默认 200 次 / 30 分钟滑动窗口，安全规则不受限。上限是防误伤，不是给模型放假。
- **空图谱结果不算合规**：`{"total":0}` / `"results":[]` / 「未找到」都不换来读窗口。
- **证据会过期**：读取证据默认 30 分钟；`inspected_ttl_ms: -1` 才恢复旧的「整会话有效」。
- **不猜路径**：目标路径只来自 `bridge/targets/*.json`；机器专属路径只放 `~/.config/agent-config-bridge/`。
- **仓库零真实值**：任何提交前跑 `bash scripts/scan-secrets.sh`；邮箱仅在凭据字段旁才算风险。
- **不要同时装两份**：门控目录只允许 `~/.pi/agent/extensions/enforce-rules/`；旧版 `graph-first-gate.ts` 若存在应删除或改名，避免双门控。
- **dsh 不对称**：它没有结果钩子与轮次级注入，所以不启用需要结果证据的检查；不要以为「配置里写了」就等于生效。

## 维护节奏

- 改规则 → 先改仓库 → `node --test` → `node scripts/scan-secrets.sh` → 本机 `node bridge/cli.js apply` → `git commit/push`。
- 回滚：`node bridge/cli.js rollback [时间戳]`；撤掉某端：`node bridge/cli.js revoke pi`。
- 新宿主机：只跑本技能的部署三条命令，不需要手工拷文件。
