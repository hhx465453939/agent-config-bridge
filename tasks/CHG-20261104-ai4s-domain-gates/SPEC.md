---
change_id: CHG-20261104-ai4s-domain-gates
version: 1
status: approved
prd_ref: PRD.md
created: 2026-11-04
owner: pi
---

# CHG-20261104 · AI4S 域判定与领域门控

## 1. 目标（可判定终态）

1. **能判域**：给定会话目录与首条用户输入，输出 `{profile, source, reason, confidence}` 四元组；判定链为 T0 指纹 → T1 强关键词 → T2 模型（依赖注入，可选）→ fallback。
2. **能分域应用检查**：`activeChecks(policy, profile)` 把基础 checks 与 profile 的 checks 合并；`general-dev` 的结果与改动前完全一致。
3. **能拦 W1**：AI4S 域下首次运行分析脚本时，若 `docs/WORKLOG.md` 不在 `worklog_ttl_ms` 窗口内，拦截并给出补救指引。
4. **能拦 W4**：分析脚本源码不含日志初始化则拦截（run 前）；本轮跑过的脚本缺同名 `.log` 则在 `turn_end` 要求补（run 后）。
5. **能提醒 W2**：本轮更新过的结果子目录缺 `README_*` 说明文件时，`turn_end` 要求补。
6. **两个适配层同源**：pi 与 dsh 都按当前 active profile 取 checks；dsh 没有 `before_agent_start`，改为首个工具事件惰性判定，判定前按 `general-dev` 放行。
7. **判定永不阻塞**：判定器抛错 / 超时 / 无 `modelHint` 一律降级为 `general-dev` + `source=fallback`。

## 2. 架构与债务

- 策略层唯一（`policy.js`）的取舍延续 ADR-003：域判定是**策略层的输入**，不是新的分发器。适配层只多做两件事——把会话的「首轮 prompt + cwd」交给 classifier，把「本轮跑过哪些脚本 / 本轮从何时开始」记进 state。
- profile 定义外置为 `bridge/gates/profiles/*.json`（单一事实源）；`policy.json` 只声明 profile 名字与 classifier 开关，避免「两份手抄副本互相漂移」（`pi-models.js` 的整个存在理由就是这一类债）。
- 已知债务：`policy.js` 已 2200 行、`parseBashCommand` 复杂度 62；本 CHG 不重构它，只在其既有结构内加两项检查与一个产物检查函数。新增代码集中在文件尾部与 `classifier.js`，不改既有检查的行为。
- 已知债务：`bridge/lib/gates.js` 需要多一个目录复制动作，才能把 `profiles/` 装进受管目录。不做这一步，安装版会永远走 fallback——这是本 CHG 必须一并修的「装进去但不生效」风险（ADR-003 §4 同类问题）。

## 3. 选定设计与 ADR

- ADR：`docs/ADR/010-ai4s-domain-gates.md`（域判定三级强度、检查强度分级、fail-open 链）。
- 判定放在 `before_agent_start`（pi）而不是 `tool_call`：`tool_call` 每次工具调用都跑，模型判定会给每次调用加一次网络往返。
- 判定结果按 prompt 哈希缓存：同一个用户轮重复触发 `before_agent_start` 不重复判定（也避免模型抖动导致同一轮换域）。
- dsh 惰性判定：dsh 没有「会话开始」钩子，首个工具事件时判定一次；判定前用 `general-dev`，即「宁少一层规矩，不多一层阻塞」。
- 产物检查唯一出口是 `outputArtifactFindings(...)`，pi 的 `turn_end` 是唯一调用方，dsh 不接（没有等价的轮结束钩子）。

## 4. 接口与配置

```js
// bridge/gates/classifier.js
classify({ cwd, prompt, fs, policy, modelHint }) ->
  { profile, source: 'fingerprint'|'keyword'|'model'|'fallback', reason, confidence }

// bridge/gates/policy.js（新增导出）
profilesFromDir(dir, fs)                       -> Map<name, profile> | null
activeChecks(policy, profile)                  -> string[]（基础 checks + profile checks，去重保序）
profilePolicy(policy, profile)                 -> policy（config 合并 profile.config，checks 已裁剪）
analysisScriptTargets(command, { cwd, isFile }) -> string[]
recordScriptRun(state, path, now)               -> void
outputArtifactFindings({ policy, state, fs, cwd }) -> Array<{code, reason}>（W2 + W4 下半）
```

`policy.json` 新增：

```json
{
  "version": 5,
  "default_profile": "general-dev",
  "profiles": ["ai4s-dry-lab", "ai4s-quant"],
  "classifier": {
    "enabled": true,
    "profiles_dir": "profiles",
    "model_judge": false,
    "timeout_ms": 8000,
    "external_judge": { "enabled": false, "note": "本阶段只留字段，不实现调用" }
  }
}
```

profile 定义（`bridge/gates/profiles/ai4s-dry-lab.json`）：

```json
{
  "name": "ai4s-dry-lab",
  "description": "...",
  "fingerprints": [["docs/STATE.md", "docs/WORKLOG.md"]],
  "keywords": { "strong": [...], "weak": [...] },
  "checks": ["ai4s-worklog-before-run", "ai4s-script-log-source"],
  "config": { "worklog_path": "docs/WORKLOG.md", "worklog_ttl_ms": 1800000,
              "result_dirs": ["results", "figures"], "readme_prefix": "README_" }
}
```

## 5. 安全脱敏

- 三个新文件（CHANGE / SPEC / DESIGN）与 profile JSON 内**不得出现**家目录绝对路径、主机名、端口、邮箱、凭据；路径一律相对仓库根或 `os.homedir()` 运行时推导。
- classifier **只读文件名与存在性**，不读文件内容：研究数据可能含未发表序列 / 患者信息，进日志即事故。
- 新增的脚本源码检查只检查「是否出现日志初始化模式」，不把脚本内容写入任何 reason。

## 6. 绝不做什么

- 不在 `tool_call` 内调用模型；不因判定不确定而阻塞（只降级）。
- 不把 ctx / 会话上下文渗进策略层（否则 dsh 需要模拟 ctx，破坏 ADR-003 分层）。adapter 只把已裁剪的 `policy` 传进去，签名 `shouldBlock({policy, input, state, fs})` 保持不变。
- 不做 W3 硬门控。
- 不实现 `external_judge` 的实际调用。
- 不改已装产物目录，不 `git add .`。
- 不为 `ai4s-quant` 编造域检查（骨架就是骨架，宁可空着）。

## 7. 里程碑

| 里程碑 | 内容 | 完成判据 |
|---|---|---|
| M0 | 基线转绿：`pi-models` 前缀归一化 + `kimi-k3` maxTokens | `node --test` 全绿 |
| M1 | `classifier.js` + 两个 profile JSON | AC-1 / AC-2 / AC-7 绿 |
| M2 | `policy.js`：`activeChecks` / `profilePolicy` / W1 / W4 / `outputArtifactFindings` | AC-3…AC-6、AC-8 绿 |
| M3 | 适配层：pi `before_agent_start` + 裁剪 policy + `turn_end`；dsh 惰性判定 | AC-9 绿 |
| M4 | `policy.json` v5、`gates.js` 复制 profiles、ADR-010、DESIGN.md | AC-10 绿 + 部署可用 |

## 8. 验收断言（每条都能红）

| AC | 断言 | 破坏方式 |
|---|---|---|
| AC-1 | 有 `docs/STATE.md` + `docs/WORKLOG.md` ⇒ `ai4s-dry-lab` / `source=fingerprint`，且 `modelHint` 未被调用 | 删 T0 → 红 |
| AC-2 | 无指纹 + 仅弱关键词（「什么是单细胞」）⇒ `general-dev` | 让 T1 单弱词锁定 → 红 |
| AC-3 | ai4s 域首跑脚本、WORKLOG 不在窗口内 ⇒ 拦，reason 含补救指引 | 删 W1 → 红 |
| AC-4 | WORKLOG 刚更新 ⇒ 放行 | 无条件拦 → 红 |
| AC-5 | 脚本源码无日志初始化 ⇒ 拦 | 删源码检查 → 红 |
| AC-6 | `turn_end` 缺 `README_*` ⇒ 有 finding，且 continue 次数受 `slack_max_continues` 限制 | 删产物检查 → 红 |
| AC-7 | 判定器抛错 / 超时 ⇒ `general-dev` + `source=fallback`，不阻塞 | 改 fail-closed → 红 |
| AC-8 | `general-dev` 的 checks 与 v4 逐条一致（同序同集合） | 改默认 checks → 红 |
| AC-9 | pi 与 dsh 都按 active profile 取 checks；dsh 惰性判定生效 | 只改 pi → 红 |
| AC-10 | `node --test` 全绿 + `scripts/scan-secrets.sh` 无命中 | 任一失败 |

## 9. Definition of Ready

- 本 SPEC 的 §1 / §8 已与用户口头对齐（用户已授权「立项 → 开发 → 测试 → 部署 → commit → push」整链）。
- 基线已实测并记录（见 `CHANGE.md` §基线），红项根因已判定、修复范围已定。
- `profiles/` 的安装路径问题已在 §2 显式列为必改项，不留「装完不生效」。

## 10. Definition of Done

- AC-1…AC-10 全部有实测证据，写入 `TRACEABILITY.md`（交付前不留「计划绿」）。
- 两个适配层、两个 policy.json、安装器、测试、ADR、DESIGN 齐头并进落地（多端一致，不缺一端）。
- `apply` 到本机后用 `doctor` 确认安装副本版本为 5 且含 `profiles/`。
- 提交按「M0 修复」与「AI4S 域门控」拆成独立 commit，显式列文件，脱敏扫描干净。
