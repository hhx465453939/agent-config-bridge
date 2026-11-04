# ADR-010 — AI4S 域判定与领域门控

```yaml
adr: 010
change_id: CHG-20261104-ai4s-domain-gates
status: accepted
date: 2026-11-04
deciders: [user]
```

## 背景

`ADR-003` 把规则文档里最关键的几条落成了硬闸门：查图谱、动脑子、不偷懒、破坏性命令不自动执行。这些规则是为**写代码**设计的。

计算生物学干实验（scRNA-seq / 空间转录组 / 跨物种比较）和量化研究有另外几条硬约束，一条都没被覆盖：

1. **跑分析脚本前必须先写 Worklog**。否则几个月后没人能回答"当时为什么这么跑、参数为什么这么选"。
2. **脚本必须自己留日志**。输出只留在 agent 的滚屏里，会话一结束就永久丢失。
3. **结果目录必须有说明文件**。`results/` 下几十个时间戳目录、无主图表，等于没做记录。
4. **文献验证（PMID 真伪）必须做**，但技术上无法静态判定。

同时有一个反作用力：把这些规则无条件套到普通开发仓库，就是纯误伤。因此必须先回答"这个会话在做什么"，再决定"跑哪些检查"。

## 决策

### 1. 判定只决定"用哪组检查"，不决定"能不能干活"

`classify()` 返回 `{ profile, source, reason, confidence }`，消费方是 `activeChecks(policy, profile)`。

这条边界是整个设计的地基：判定必然有误差（弱关键词、跨域仓库、模型胡说），如果误差能阻塞工作，门控就从"帮忙"变成"卡死"。所以每一条失败路径都收敛到 `general-dev`（基础规则，即 v4 行为），而不是 deny。

### 2. 三级判定，按"证据强度 / 成本"排序

| 级 | 输入 | 成本 | 置信度 | 为什么 |
|---|---|---|---|---|
| T0 指纹 | 文件是否存在（`docs/STATE.md` + `docs/WORKLOG.md`） | 几次 `stat` | 0.95 | 结构性事实，无法用措辞伪造 |
| T1 强关键词 | 首条用户输入，**≥2 个互不相同**的强词 | 正则 | 0.70 | 一个强词不够：「什么是单细胞」是提问，不是研究工作流 |
| T2 模型 | prompt + 候选域，依赖注入 | 一次网络往返（默认 8s 超时） | 0.50 | 前两级都不确定时才花钱 |
| fallback | — | 0 | 0 | 判不出来就少一层规矩 |

弱关键词只进 `reason`，绝不单独锁定域。模型给出的 profile 名必须存在于 profile 表里，否则视为失败（模型不能开关一组不存在的规则）。

### 3. 判定时机：每用户轮一次，且不在 `tool_call` 里

- pi：`before_agent_start`。每次用户请求一次，正好是"这一轮在做什么"的粒度。
- dsh：没有 `before_agent_start`，改为**首个工具事件惰性判定**，判定前按 `general-dev` 放行。dsh 也拿不到用户 prompt，所以实际上只有 T0 可用——这个不对称写清楚，不装作全功能。
- **绝不在 `tool_call` 里调模型**：那会给每一次工具调用加一次网络往返，是最快让人卸载门控的做法。
- 同一 `(cwd, prompt)` 哈希缓存判定结果：重试 / 恢复 / 压缩触发的重复 `before_agent_start` 不重复判定，也避免同一轮内换域。

### 4. profile = 具名检查集合，只做增量

```js
activeChecks(policy, profile) = dedupe([...policy.checks, ...profile.checks])
```

- 基础层（图谱 / 动脑子 / 安全 / CHG 契约）只有一处，改一次全端生效——这是 ADR-003 反对"规则分叉"的直接延续。
- 域层只声明**额外**要什么，读代码的人一眼能看出 AI4S 比普通开发多了哪两条。
- `general-dev` 不是一条 profile 定义，而是"profile 表里没有对应项 ⇒ 只跑基础层"。因此"general-dev 的 checks 与 v4 完全一致"不靠新代码保证，而靠**没有新增分支**保证。
- profile 只能 ADD，不能 REMOVE——域永远无法关掉一条安全规则。

### 5. 检查强度分级：能改一个字节就继续的硬拦，其余提醒

| 编号 | 检查 | 时机 | 强度 | 理由 |
|---|---|---|---|---|
| W1 | 跑脚本前 Worklog 是否新鲜 | `tool_call` | 硬拦 | 跑之前拦成本为零（补一行就能继续）；跑之后提醒等于追认 |
| W4 上半 | 脚本源码是否有日志初始化 | `tool_call` | 硬拦 | 静态可判定，且不写日志跑完就永久丢输出 |
| W4 下半 | 是否留下同名 `.log` | `turn_end` | `continue` | 产出问题，补跑一次即可 |
| W2 | 结果子目录是否有 `README_*` | `turn_end` | `continue` | 不影响计算结论，再要一轮足够 |
| W3 | 文献 PMID 真伪 | — | **不做** | 正则只能证明"写了 PMID"，证明不了"对得上"。可被伪造值绕过，硬拦只制造形式主义安全感 |

一句话原则：**「现在拦下来，用户改一个字节就能继续」→ 硬拦；「事后才发现、改起来要重跑」→ 提醒；「技术上无法判定对错」→ 不做。**

`continue` 受 `slack_max_continues` 约束，与既有的"轮次级不偷懒"共用同一个计数器，防误报把 agent 拖进无限补写循环。

### 6. 只在 `turn_end` 做产物检查

`outputArtifactFindings()` 是 W2 / W4 下半的唯一出口，`turn_end` 是唯一调用方。`tool_call` 里做产物检查等于给每次调用加一次 `readdir`——而产物只在"这一轮结束时"才有意义。

由此 `state` 需要两个新事实：`turnStart`（本轮边界）与 `scriptsRun`（本轮跑过什么脚本、何时开始）。没有 `turnStart` 就**不做任何产物判定**：没有边界就没有"本轮的产出"，否则每次都会把机器上所有旧目录报一遍。

### 7. 时间戳比较必须带容差（实测踩到的坑）

`Date.now()` 与文件 mtime 在毫秒尺度上**不一致**：实测一个"紧接着写的文件"，其 mtime 可比写入前的 `Date.now()` 早 2–3ms（时钟粒度 / 文件系统时间戳取整）。

若不设容差，"这次运行产生了日志"会对**它刚刚产生的日志**判假——每次运行必假阳性，比偶尔放过一个旧日志糟得多。

因此新增 `artifact_mtime_epsilon_ms`（默认 2000），与既有的 `index_mtime_epsilon_ms` 同源同理由。

### 8. profile 定义外置，policy.json 只写名字

`bridge/gates/profiles/*.json` 是唯一事实源；`policy.json` 只声明 `profiles: ["ai4s-dry-lab", "ai4s-quant"]` 与 classifier 开关。

理由直接来自本仓库已有的教训：`bridge/lib/pi-models.js` 整个模块的存在目的，就是收拾"同一份事实被手抄两份、彼此漂移"的债。域定义若同时存在于 policy.json 和 profiles/，就是同一个债再借一次。

加载路径两种布局都要能解析：仓库检出用 `../profiles`，安装版用 `<gate>/profiles`；都解析失败时降级为 `general-dev`，并把未解析的名字留在 `pendingProfiles` 里供测试/status 报告，而不是静默丢失。

**安装器必须复制 `classifier.js` 与 `profiles/`**——这一步漏了，装机版要么加载失败（`ERR_MODULE_NOT_FOUND`），要么装好却永远判成 `general-dev`。`gates.test.js` 里那条"installed layout really loads"就是为这类"装进去但不生效"准备的，本次它确实抓到了一次漏复制。

## 被否方案

### 方案 A：给 AI4S 单独做一套门控扩展

否决原因：规则逻辑分叉。改一次"什么算代码文件"要改两处，漏一处就出现"pi 管、dsh 不管"的静默不一致——ADR-003 方案 A 已经否过一次。

### 方案 B：用 `tool_call` 里的关键词即时判定（无 T0）

否决原因：`tool_call` 太频繁，判定成本被放大；而且"一次工具调用"看不到用户这一轮的意图，容易在同一个任务内反复换域。

### 方案 C：W3 也做硬拦

否决原因见 §5：技术上不可判定。硬拦会产出"已验证"的假信号，比不拦更危险。

### 方案 D：判定结果持久化到磁盘（跨会话记住域）

暂缓，非否决：需要一个"域变化时失效"的语义，而当前没有可靠信号。本轮先做会话内判定；`reason` / `source` 已落进 state，将来要扩展有地方接。

## 后果

### 正向

- 研究型会话的三条硬约束真的会被执行，且只在研究型会话执行；
- 判定失败只降级不阻塞，最坏情况回到 v4 行为；
- 一个域检查 = profile 里的一行字符串，加域不需要改适配层；
- 规则层（`policy.js`）依旧不知道 harness 的存在：`shouldBlock` 签名未变，profile 通过 `policy` 传入。

### 负向 / 需接受

- dsh 只有 T0 可用（拿不到 prompt），域判定能力弱于 pi——写清而不假装；
- 产物检查（W2 / W4 下半）只在 pi 生效，因为 dsh 没有轮结束钩子；
- `ai4s-quant` 目前只是骨架（`checks: []`），只做识别与不误伤；
- 时间戳容差 2s 意味着"跑前 1.9s 内写的日志"也会被接受——这是为消除必假阳性付出的代价，可接受。

## 相关

- `bridge/gates/classifier.js`、`bridge/gates/profiles/`、`bridge/gates/policy.js`（`activeChecks` / `profilePolicy` / W1 / W4 / `outputArtifactFindings`）
- `bridge/gates/pi/index.js`（`before_agent_start`）、`bridge/gates/dsh/index.js`（惰性判定）
- `bridge/lib/gates.js`（安装计划：`classifier.js` + `profiles/`）
- `docs/ADR/003-hard-gates.md`（分层与 fail-open 的源头）
- `tasks/CHG-20261104-ai4s-domain-gates/DESIGN.md`（面向审稿人的设计说明）
