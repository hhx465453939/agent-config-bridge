# HANDOFF · CHG-20261104 · AI4S 域判定与领域门控

跨 session 交接书。上一个 session 因工具调用标签编码损坏而报废，未留下任何代码。

路径均相对仓库根（本文件在 `tasks/CHG-20261104-ai4s-domain-gates/`，向上两级即仓库根）。
不写绝对路径原因：本仓库公开，CONTRIBUTING.md 禁止提交家目录绝对路径。

## 1. 仓库约定

- Node ≥ 20；零第三方依赖，只允许 `node:` 标准库导入。
- 无 `package.json`、无 lint/build，测试直接 `node --test`。
- 必读：`CONTRIBUTING.md`（零敏感值铁律 + 提交规范）、`docs/ADR/003-hard-gates.md`（架构原则）。
- git（实测）：`main...origin/main`，工作区干净。
- 既有测试 8 个，在 `bridge/test/`：engine、gates、gate-policy、gate-adapter、gate-deploy、gate-v4、bootstrap、pi-models，另有 `sandbox.js`。

## 2. 磁盘真实状态（实测，勿信任何"已完成"）

| 项 | 状态 |
|---|---|
| 本 CHG 目录 | 此前不存在；上一 session 写入全部失败，无半成品 |
| `node --test` | EXIT=1，既有失败 `ERR_ASSERTION actual: undefined expected: true`，用例名未定位 |
| `scan-secrets.sh` | EXIT=0，93 文件干净 |
| 已装门控 | 受管扩展目录是 apply 产物，不可直接改（revoke 会整目录还原） |

## 3. 第一步（阻塞，必须先做）

定位 `node --test` 的既有失败：拿到失败用例全名 + 断言上下文，判它是代码缺陷还是环境问题，结论写进 `CHANGE.md` 基线小节。

绝不允许带红基线开发后声称"测试全绿"。那是假绿，比不测更危险。

## 4. 第二步：建 CHG（status: draft，用户批准后才动代码）

照抄 `tasks/CHG-20261031-gate-p2-hardening/` 四件套的格式与文风（精炼、AC 必须"能红"、有"独占文件"与"绝不做什么"）：

- `CHANGE.md`：根因 / 改动表 / 未做 / 基线（含第 3 步实测结论）。
- `PRD.md`：承诺 / 不承诺 / 边界条件 / 未决问题。
- `SPEC.md`：frontmatter(`change_id`, `version: 1`, `status: draft`, `prd_ref`) + 目标 / 架构与债务 / 选定设计与 ADR / 接口与配置 / 安全脱敏 / 绝不做什么 / 里程碑 / AC / DoR / DoD。
- `TRACEABILITY.md`：PRD→SPEC→AC 映射 + AC→实现位置→证据（交付前不填"计划绿"）。
- `DESIGN.md`（用户明确要求）：供开源后审稿人查看"agent 工作流结构化 IO 的源码和设计思路"，须含六项：
  1. 三级判定流程图（T0 指纹 → T1 关键词 → T2 模型），每级输入/成本/位置/置信度。
  2. classifier 结构化输出契约（字段语义、类型、取值域、消费方）。
  3. profile 与 checks 的关系（为何 profile = checks 的命名集合）。
  4. 三条域检查强度分级理由（W1/W4 硬拦、W2 用 continue、W3 不做）。
  5. fail-open 判定链（为何判错只降级不阻塞）。
  6. 与 ADR-003 一致性（策略层/适配层分离如何延续）。

## 5. 已定设计（不要重新决策）

1. 新增 `bridge/gates/classifier.js`：纯代码零依赖；模型判定用依赖注入（可选 `modelHint` 回调），测试注入假实现，不依赖真实模型。输出契约：

   ```
   { profile: 'ai4s-dry-lab'|'ai4s-quant'|'general-dev', source: 'fingerprint'|'keyword'|'model'|'fallback', reason, confidence }
   ```

2. 新增 `bridge/gates/profiles/ai4s-dry-lab.json`、`ai4s-quant.json`（quant 只留骨架）。
3. 改 `bridge/gates/policy.js`：
   - `normalizePolicy`（195-221）支持 `profiles` + `default_profile`；新增 `activeChecks(policy, profile)`。
   - 保持 `shouldBlock({policy, input, state, fs})` 签名不变（1688-1712，25 行分发器）。adapter 传已裁剪 policy：`{...policy, checks: activeChecks(...)}`。绝不把 ctx 渗进策略层（否则 dsh 要模拟 ctx，破坏 ADR-003 分层）。
   - 新增 `ai4s-worklog-before-run`（W1）：bash 首跑分析脚本（`.R/.Rmd/.r/.py/.ipynb`）前，`docs/WORKLOG.md` mtime 须在 `worklog_ttl_ms`（默认 1800000）内。
   - 新增 `ai4s-script-log-source`（W4 上半）：脚本源码须含日志初始化（R: `Sys.time`/`sink`；Py: `logging`/`FileHandler`）。
   - 新增导出 `outputArtifactFindings({policy, state, fs, cwd})` 供 turn_end：W4 下半（本轮脚本须有同名 `.log`，mtime ≥ 脚本启动）+ W2（本轮更新的 `ai4s_result_dirs` 子目录须含 `README_文件说明.md`）。
4. 改 `bridge/gates/pi/index.js`：新增 `before_agent_start` 判定，每用户轮一次，绝不放 `tool_call`（避免每次工具调用加延迟），prompt 哈希缓存；`tool_call` 用裁剪后 policy；`turn_end` 调 `outputArtifactFindings`，有 finding 返 `continue`（受 `slack_max_continues` 限制）；state 增 `profile`/`profileSource`/`scriptsRun`/`turnStart`。
5. 改 `bridge/gates/dsh/index.js`：无 `before_agent_start` → 首个工具事件惰性判定，判定前按 `general-dev` 放行。
6. 改两个 `policy.json`：`version: 4 → 5`，加 `classifier`/`profiles` 段，`default_profile: "general-dev"`；`external_judge` 只留字段不实现调用（用户已确认本阶段不需要）。
7. 新增 `bridge/test/gate-ai4s.test.js`、`docs/ADR/011-ai4s-domain-gates.md`。

## 6. 十条 AC（每条必须"能红"）

| AC | 断言 | 破坏方式 |
|---|---|---|
| AC-1 | 有 `docs/STATE.md`+`docs/WORKLOG.md` → 判 `ai4s-dry-lab`，`source=fingerprint`，未调模型 | 删 T0 → 红 |
| AC-2 | 无指纹 + 仅弱关键词（"什么是单细胞"）→ `general-dev` | 让 T1 单独锁定 → 红 |
| AC-3 | ai4s 下首跑脚本、WORKLOG 未在窗口内更新 → 拦，理由含补救指引 | 删检查 → 红 |
| AC-4 | WORKLOG 刚更新 → 放行 | 无条件拦 → 红 |
| AC-5 | 脚本源码无日志初始化 → 拦 | 删源码检查 → 红 |
| AC-6 | `turn_end` 缺 `README_文件说明.md` → `continue` 且受 `slack_max_continues` 限制 | 删产物检查 → 红 |
| AC-7 | 判定器抛错/模型超时 → `general-dev` + `source=fallback`，不阻塞 | 改 fail-closed → 红 |
| AC-8 | `general-dev` 既有 10 条 checks 逐条不变 | 改默认 checks → 红 |
| AC-9 | pi 与 dsh 都按 active profile 取 checks；dsh 惰性判定生效 | 只改 pi → 红 |
| AC-10 | `node --test` 全绿 + `scan-secrets.sh` 无命中 | 任一失败 |

## 7. 铁律

- 零第三方依赖，只用 `node:` 标准库。
- 脱敏：不得出现家目录绝对路径 / 主机名 / 端口 / 邮箱 / 凭据；仓库路径运行时探测。
- classifier 只读文件名与存在性，不读文件内容（防研究数据进日志）。
- plan 先于 apply；写前备份；fail-fast；不猜路径（路径只来自 `bridge/targets/*.json`）。
- 不改已装产物目录。
- 不做 W3 文献验证硬门控：正则只能查"有没有写 PMID"，查不出对错，可被伪造值绕过；硬拦只制造形式主义安全感。W3 留提醒层。
- 不在 `tool_call` 内调模型；不因判定不确定而阻塞，只降级。

## 8. 流程与提交

立项 → 开发 → 测试 → 部署 → commit → push 一条龙，用户已授权整链，但：

1. commit 前测试必须实测真绿。
2. commit message：`<type>(<scope>): <简述>`，type ∈ feat/fix/docs/test/chore/refactor，scope ∈ bridge/targets/mcp/docs/ci。
3. 禁 `git add .`，显式列文件；一次提交只做一件事。
4. push 前再确认脱敏扫描干净。

## 9. 门控要求（本项目自带 enforce-rules 会真拦你）

1. 读代码前先走图谱：project = `home-shpc_101170-Development-agent-config-bridge`（已索引，勿重复索引）。
2. 改代码前，本会话必须已读该 CHG 的 `SPEC.md` 或 `PRD.md`。
3. 改已存在文件前，本会话必须读过它（30 分钟窗口）。
4. 改之前先读 `CONTRIBUTING.md`。

## 10. 图谱提示：policy.js 关键位置

`policy.js` 约 1740 行。用 `search_graph`（`label=Function`, `file_pattern=bridge/gates/policy.js`）可重新取全表。重点：

- `normalizePolicy` 195-221；`newSessionState` 355-387；`newestMtimeIn` 1211-1226
- `normalizePath` 424-434；`finding` 1096；`isCodeFile` 270-277
- `shouldBlock` 1688-1712（25 行分发器，签名不可变）；`reminderFor` 1721-1733
- `parseBashCommand` 841-1037（复杂度 62，全文件最复杂）

ADR-003 核心取舍（须延续）：策略层唯一、适配层薄（怕规则分叉：改一处漏一处会出现"pi 管 dsh 不管"的静默不一致）；闸门走受管路径可撤回；策略读不出来 fail open + 告警，安全类规则独立 fail closed；每会话拦截上限防规则写错无限浪费。

## 11. 上一 session 失败原因（不影响接手）

工具调用标签被写成全角字符，整个调用块被当纯文本输出，命令从未执行。环境正常（`scan-secrets.sh` 与 `git status` 曾成功返回真实结果），问题仅在会话输出编码。

接手自保：写文件后立即 `ls -l` 确认落盘；一次调用别塞超长内容，宁可分多次；见到工具调用返回乱码立刻停手，别重试同样写法。
