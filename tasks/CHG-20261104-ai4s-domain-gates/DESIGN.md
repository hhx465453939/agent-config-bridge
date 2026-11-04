# DESIGN · AI4S 域判定与领域门控

> 面向开源后的审稿人：这份文档解释 `bridge/gates/` 里「agent 工作流结构化 IO」的设计思路——
> 判定怎么分级、输出契约长什么样、为什么三档检查的强度不一样。
> 实现见 `bridge/gates/classifier.js`、`bridge/gates/policy.js`、`bridge/gates/profiles/`。

## 0. 一句话

门控原本只有一套规则（查图谱 / 动脑子 / 不偷懒）。AI4S 研究有额外硬约束（跑前写 Worklog、脚本留日志、结果目录留说明），
但把这些规则无条件套到普通开发仓库就是误伤。所以先判「这个会话属于哪个域」，再按域拼一组检查：
**判定只决定用哪组规矩，不决定能不能干活。**

## 1. 三级判定流程

```
                      ┌──────────────────────────────┐
  before_agent_start  │ cwd + 首条 prompt + fs 探针   │
  (dsh: 首个工具事件)  └──────────────┬───────────────┘
                                     ▼
                    ┌────────────────────────────────┐
              T0    │ 指纹：文件存在性（不读内容）      │
                    │ docs/STATE.md + docs/WORKLOG.md │
                    └───────┬────────────────┬───────┘
                     命中    │                │ 未命中
                             ▼                ▼
                     profile 确定     ┌──────────────────────┐
                     conf 0.95        │ T1 强关键词（≥2 个）   │
                                      └───────┬──────────────┘
                                       命中    │            │ 未命中 / 只有弱词
                                               ▼            ▼
                                       profile 确定   ┌────────────────────┐
                                       conf 0.7       │ T2 模型判定（可选）  │
                                                      │ modelHint 注入      │
                                                      └───────┬────────────┘
                                                       成功    │        失败/超时/
                                                               ▼        无 modelHint
                                                       profile 确定   ┌──────────────┐
                                                       conf 0.5       │ fallback     │
                                                                      │ general-dev  │
                                                                      │ conf 0       │
                                                                      └──────────────┘
```

| 级 | 输入 | 成本 | 位置 | 置信度 | 为什么要这一级 |
|---|---|---|---|---|---|
| T0 指纹 | 目录下若干文件是否存在 | 微秒级（几次 `stat`） | `classifier.js::fingerprintHit` | 0.95 | 结构性事实最可信：一个仓库同时有 `docs/STATE.md` 和 `docs/WORKLOG.md`，几乎不可能是巧合 |
| T1 强关键词 | 首条用户输入 + 强词表 | 微秒级（正则） | `classifier.js::keywordHit` | 0.7 | 用户开口就说「跑单细胞注释流程」时不必等模型；但必须 ≥2 个互不相同的强词，否则「什么是单细胞」这种提问会把问答误判成研究 |
| T2 模型 | prompt + 候选域说明 | 一次网络往返（默认超时 8000ms） | `classifier.js::modelVerdict`（`modelHint` 依赖注入） | 0.5 | 前两级都不确定时才花钱；注入式设计让测试用假实现，不依赖真模型 |
| fallback | — | 0 | `classifier.js::classify` 的 catch / 缺省分支 | 0 | 判不出来就退到「什么都不加」，而不是「拦住」 |

**弱关键词只做提示、不做判定**：它们会进 `reason` 供人看，但单独出现（不足 2 个强词）绝不锁定域。这是 AC-2 守的那条线。

## 2. classifier 结构化输出契约

```js
{ profile: 'ai4s-dry-lab' | 'ai4s-quant' | 'general-dev',
  source:  'fingerprint' | 'keyword' | 'model' | 'fallback',
  reason:  string,        // 人类可读，含命中的具体证据（文件名 / 关键词 / 模型理由）
  confidence: number }    // 0..1，供将来做「低置信度只提醒」的演进
```

| 字段 | 类型 | 取值域 | 语义 | 消费方 |
|---|---|---|---|---|
| `profile` | string | 三个域之一，或 profile 表里声明的名字 | 「用哪组检查」的唯一依据 | `policy.js::activeChecks` / `profilePolicy`，两个适配层 |
| `source` | string | `fingerprint` / `keyword` / `model` / `fallback` | 结论从哪一级来。**`fallback` 是契约的一部分**：调用方可以据此区分「确实判成 general-dev」与「没判出来」 | 适配层（写入 `state.profileSource`）、测试（AC-1 断言「未调用模型」）、审计 |
| `reason` | string | 任意文本，不含文件内容 | 给人看的一句话证据 | 适配层 `ctx.ui.notify` / stderr |
| `confidence` | number | 0..1 | 该级判定的可信度 | 目前只记录，不参与决策（避免「置信度阈值」变成新的调优点） |

契约的硬约束：
- **只读文件名与存在性**，不读文件内容，`reason` 里也不出现文件内容——研究数据可能是未发表序列或患者信息。
- **永不抛错**。内部任何异常都被收敛成 `fallback`（见 §5）。
- **不返回「不确定」这个第四种 profile**。要么三个域之一，要么 fallback 到 `general-dev`；多一个状态就多一条调用方要处理的路径。

## 3. profile 与 checks 的关系

**profile 就是一个命名的检查集合**（外加这组检查要读的配置）。没有别的。

```json
{
  "name": "ai4s-dry-lab",
  "fingerprints": [...],            // 只喂 T0
  "keywords": { "strong": [...], "weak": [...] },   // 只喂 T1
  "checks": ["ai4s-worklog-before-run", "ai4s-script-log-source"],
  "config": { "worklog_path": "docs/WORKLOG.md", "worklog_ttl_ms": 1800000,
              "result_dirs": ["results", "figures"], "readme_prefix": "README_" }
}
```

```js
activeChecks(policy, profile) =
  dedupe([ ...policy.checks,              // 基础层：所有域都跑（图谱 / 动脑子 / 安全 / 契约）
           ...policy.profiles[profile].checks ])   // 域层：只在该域追加
```

为什么是这个形状，而不是「每个域写一份完整 checks 列表」：

1. **基础层只有一处**。图谱规则、安全规则、CHG 契约规则改一次就全端生效——ADR-003 反对的正是「改一处漏一处出现 pi 管 dsh 不管」。
2. **域层是纯增量**。`ai4s-dry-lab` 只声明它**额外**要什么，读代码的人能一眼看出「AI4S 比普通开发多了哪两条」。
3. **`general-dev` 天然等于「什么都不加」**：它不是一条假 profile，而是「profile 表里没有对应项 ⇒ 只跑基础层」。所以 AC-8（既有 checks 逐条不变）不是靠新代码保证的，而是靠「没有新增分支」保证的。
4. **加载路径只有一条**：`policy.json` 只写 profile **名字**，定义在 `bridge/gates/profiles/*.json`。避免「policy.json 里抄一份、profiles 里再抄一份」的漂移——`bridge/lib/pi-models.js` 整个模块的存在理由就是收拾这种债。

## 4. 三条域检查的强度分级（为什么不一样）

| 编号 | 检查 | 时机 | 强度 | 理由 |
|---|---|---|---|---|
| W1 | 跑分析脚本前 Worklog 是否新鲜 | `tool_call`（bash） | **硬拦** | 这是「先想清楚再跑」的物理落点。跑之前的拦是**零成本**的：脚本还没执行，改一下 Worklog 就能继续。反过来，跑完再提醒等于事后追认，Worklog 就变成了流水账 |
| W4 | 脚本必须日志初始化（run 前）+ 同名 `.log`（run 后） | run 前硬拦 / run 后 `continue` | **硬拦 + 软提醒** | run 前：源码里有没有 `sink` / `logging` 是**静态可判定**的，且不写日志跑完就永久丢失输出——那一刻拦下来价值最高。run 后：日志缺失是补跑一次就能解决的产出问题，卡死流程的代价大于收益 |
| W2 | 结果子目录必须有 `README_*` 说明 | `turn_end` | **软提醒（continue）** | 说明文件是「给人看」的，漏写不影响本轮任何计算结论。它天然属于「再要一轮就能补完」的类别，用 `continue` 让 agent 自己补，比 deny 一个已经完成的分析更合理 |
| W3 | 文献验证（PMID 是否真实对应） | — | **不做** | 正则只能证明「写了 PMID」，证明不了「PMID 对得上结论」。可被伪造值绕过 → 硬拦只制造形式主义安全感，还给出「已验证」的假信号。留提醒层，由人核 |

分级原则一句话：**「现在拦下来，用户改一个字节就能继续」→ 硬拦；「事后才发现、改起来要重跑」→ 提醒；「技术上无法判定对错」→ 不做。**

## 5. fail-open 判定链

判定器的每一个失败点都收敛到 `general-dev`，而不是阻塞：

```
classify()
 ├─ profile 表读不出来 ────────────► general-dev / fallback
 ├─ T0 探针抛错（fs 异常）─────────► 跳过 T0，继续 T1
 ├─ T1 正则异常 ───────────────────► 跳过 T1，继续 T2
 ├─ T2 无 modelHint ───────────────► general-dev / fallback
 ├─ T2 抛错 / 超时 ────────────────► general-dev / fallback
 └─ profile 名不在表里 ────────────► general-dev / fallback
```

理由与 ADR-003 §5 同源：**门控坏了就把 agent 卡死，比某条规则暂时没执行严重得多。**
域判定的产物是「多加两条研究规矩」，不是「允许/禁止写盘」，所以它的失败方向只能是「少一层规矩」。

与之相对，**安全类检查（凭据写入 / 越界写入 / 破坏性命令）永远 fail-closed**，且不受每会话拦截上限约束（`HARD_CHECKS`）。
两者不是同一种风险：一个管「研究规范」，一个管「不可恢复的破坏」。

## 6. 与 ADR-003 的一致性

| ADR-003 的原则 | 本 CHG 如何延续 |
|---|---|
| **策略层唯一、适配层薄** | 判定与检查全部在 `policy.js` / `classifier.js`。适配层只做三件翻译：把「首轮 prompt + cwd」喂给 classifier；把「本轮跑了什么脚本、本轮何时开始」记进 state；把裁剪后的 policy 传给 `shouldBlock` |
| **不把 ctx 渗进策略层** | `shouldBlock({policy, input, state, fs})` **签名不变**。profile 通过 `policy` 本身传入（`profilePolicy` 合并 config 与 checks），策略层依旧看不见任何 harness 词汇。dsh 因此不需要模拟 ctx |
| **闸门走受管路径、可撤回** | 新增的 `profiles/` 与两个 `policy.json` 都在 `planGateInstall` 的计划里，`adopt` 快照、`revoke` 还原。为此 `bridge/lib/gates.js` 增加目录复制动作——**装进去不生效等于没装**，这是 ADR-003 §4 已经踩过的坑 |
| **策略读不出来 fail open + 告警；安全规则独立 fail closed** | 判定链见 §5；`HARD_CHECKS` 保持原样，新增的两项域检查**不进** `HARD_CHECKS`（域规矩不该享有安全级豁免与永久生效） |
| **每会话拦截上限防规则写错** | 域检查受 `max_blocks_per_session` 约束；`turn_end` 的 `continue` 另受 `slack_max_continues` 约束，防误报把 agent 拖进无限补写循环 |
| **一处规则，多端生效** | pi 与 dsh 共用同一个 `activeChecks`；差异只在「何时判定」（pi 有 `before_agent_start`，dsh 惰性），不在「判定什么」 |

## 附：一次真实调用的数据流

```
用户: "帮我跑一下单细胞注释流程"
  │
  ├─ pi: before_agent_start   → classify({cwd, prompt, fs})
  │      T0: docs/STATE.md ✓ docs/WORKLOG.md ✓  → ai4s-dry-lab / fingerprint
  │      state.profile = 'ai4s-dry-lab'; state.turnStart = now
  │      effectivePolicy = profilePolicy(policy, 'ai4s-dry-lab')
  │
  ├─ 模型: bash "Rscript scripts/annotate.R"
  │      tool_call → shouldBlock({policy: effectivePolicy, input, state, fs})
  │        W1: WORKLOG mtime 40 分钟前 > 30 分钟窗口 → BLOCK（带补救指引）
  │
  ├─ 模型: 更新 docs/WORKLOG.md → 重跑
  │      W1 放行；W4 上半: 源码无 sink/Sys.time → BLOCK
  │      state.scriptsRun.set(script, {startedAt})
  │
  └─ turn_end → outputArtifactFindings()
         W4 下半: 缺 annotate.R.log → continue（补日志）
         W2: results/20261104/ 有图无 README_文件说明.md → continue
```
