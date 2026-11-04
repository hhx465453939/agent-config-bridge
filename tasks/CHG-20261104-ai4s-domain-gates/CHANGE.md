---
change_id: CHG-20261104-ai4s-domain-gates
status: approved
---

# CHANGE · 改了什么、为什么

## 根因

1. **门控只有一套规则**：`graph-first-gate` 把「查图谱 + 动脑子 + 不偷懒」硬性执行了，但这些规则是为写代码的仓库设计的。AI4S（干实验 / 量化研究）工作流有它自己的硬约束——跑分析脚本前要先写 Worklog、脚本必须把输出落到日志、结果目录必须带说明文件——一条都没有被门控覆盖。研究型 agent 可以在完全不记录推理的情况下跑几十轮分析，事后无人能追溯。
2. **没有「本轮在做什么」的概念**：策略层对每次工具调用一视同仁，无法区分「改代码」与「跑科研流水线」。把 AI4S 规则无条件套到所有仓库，会让普通开发被研究规矩误伤；反过来只在 AI4S 仓库生效，又需要先判定「这个会话属于哪个域」。
3. **域判定本身不能成为新的失败源**：判定错就阻塞，会让门控从「帮忙」变成「卡死」。而判定必然不可能 100% 准确（弱关键词、跨域仓库、模型判错），所以判定结论只能**决定应用哪组检查**，不能决定「是否允许工作」。

## 前置修复（M0，单独 commit）

基线实测 `node --test` 是**红**的：2 个失败，全在 `bridge/test/pi-models.test.js`。判根因如下（非环境问题，是代码缺陷 + 表漂移）：

| # | 现象 | 根因 |
|---|---|---|
| 1 | 10 条 `FAMILY_TABLE_STALE`「probed but pi's X.json does not list it」 | pi 1.2.0 的 provider 数据把模型 id 写成 `<kind>:<id>`（如 `chat:kimi-k3`）。`readOfficialModels` 只做 `toLowerCase()`，没有剥掉命名空间前缀，于是索引键是 `chat:kimi-k3`，`index.get('kimi-k3')` 永远 miss——10 条全是假阳性 |
| 2 | 剥前缀后仅剩 1 条真实冲突 | `kimi-k3` 的 `maxTokens`：`moonshotai.json` / `moonshotai-cn.json` 写 1048576，其余 4 个 provider 文件写 131072。按本表自己的教义（「sources disagree ⇒ assert nothing」）该家族应声明 `maxTokens: null`，与 `claude-opus-4.6+` 同一处置 |

带红基线开发等于假绿，因此先修：`bridge/lib/pi-models.js`（剥前缀 + `kimi-k3` 改 null）与 `bridge/test/pi-models.test.js`（补一条前缀归一化的用例，锁住这次回归）。

## 改动

| 文件 | 改动 |
|---|---|
| `bridge/lib/pi-models.js` | M0：`readOfficialModels` 剥 transport 命名空间前缀；`kimi-k3` 家族 `maxTokens: null` 并注明两个冲突来源 |
| `bridge/test/pi-models.test.js` | M0：新增「带 `chat:` 前缀的 id 必须归一化后命中」用例 |
| `bridge/gates/classifier.js` | 新增：三级域判定（T0 指纹 → T1 关键词 → T2 模型），纯函数 + 依赖注入，失败降级 |
| `bridge/gates/profiles/ai4s-dry-lab.json` | 新增：干实验域定义（指纹 / 关键词 / checks / config） |
| `bridge/gates/profiles/ai4s-quant.json` | 新增：量化域骨架（只有指纹与关键词，无域检查） |
| `bridge/gates/policy.js` | `normalizePolicy` 支持 `profiles` / `default_profile` / `classifier`；新增 `activeChecks`、`profilePolicy`；新增两项 W1/W4 检查；新增 `outputArtifactFindings`（W2 / W4 下半）；新增 `analysisScriptTargets`、`recordScriptRun` |
| `bridge/gates/pi/index.js` | 新增 `before_agent_start` 判定（每用户轮一次，按 prompt 哈希缓存）；`tool_call` 改用裁剪后的 profile policy；`turn_end` 追加产物检查 |
| `bridge/gates/dsh/index.js` | 无 `before_agent_start`，改为首个工具事件惰性判定；判定前按 `general-dev` 放行 |
| `bridge/gates/pi/policy.json`、`bridge/gates/dsh/policy.json` | version 4 → 5；新增 `classifier` / `profiles` / `default_profile` / `external_judge` 字段 |
| `bridge/lib/gates.js` | 安装计划里增加 `profiles/` 目录的复制动作（否则装完没有域定义，判定永远走 fallback） |
| `bridge/test/gate-ai4s.test.js` | 新增：AC-1…AC-9 的用例 |
| `docs/ADR/011-ai4s-domain-gates.md` | 新增：域判定与检查强度分级的决策记录 |

## 未做

- 不做 W3（文献验证）硬门控：正则只能查「有没有写 PMID」，查不出对错，可被伪造值绕过；硬拦只制造形式主义安全感。留提醒层。
- 不实现 `external_judge` 的模型调用，只保留字段与开关（用户已确认本阶段不需要）。
- 不改已装产物目录（受管扩展目录是 apply 产物，`revoke` 会整目录还原）。
- 不在 `tool_call` 内调模型：判定放在 `before_agent_start`，每用户轮最多一次。

## 基线（实测，2026-11-04）

```
node --test bridge/test/*.test.js   # EXIT=1，194 tests / 191 pass / 2 fail
bash scripts/scan-secrets.sh        # EXIT=0，93 文件干净
```

red 项：`pi-models.test.js` 两条（见上「前置修复」）。交付前必须转为 `EXIT=0` 且 `scan-secrets.sh` 无命中。
