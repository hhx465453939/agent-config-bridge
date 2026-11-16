# TRACEABILITY：CHG 契约门控升级为「契约成立」

## 需求 → 契约 → 产物 追溯

| 需求 / 判据 | SPEC 条款 | 产物 | 验收方式 | 状态 |
|---|---|---|---|---|
| R-1 契约必须齐全（SPEC+PRD+TRACEABILITY） | §1.1 | `policy.js` `auditChgContract` / `chg_contract_required_files` | `gate-policy.test.js`「只写一个 SPEC.md 不许开工（缺 PRD / TRACEABILITY）」 | 已验 |
| R-2 SPEC 必须有验收判据 | §1.2 | `policy.js` `chgSpecHasAcceptance` / `chg_acceptance_markers` | 「SPEC 没有验收判据要拦」 | 已验 |
| R-3 draft 状态不许开工 | §1.3 | `policy.js` `chgStatusOf` / `chg_status_allow` | 「draft 状态不许开工」+「缺 status 字段不拦」 | 已验 |
| R-4 契约必须属于当前项目 | §1.4 | `policy.js` `withinRoot(projectRoot, …)` 过滤 | 「读别的仓库的 CHG 契约不给本项目解锁」 | 已验 |
| R-5 拒绝信息逐条可指导 | §1.6 / §1.1 | `CHG_CONTRACT` / `CHG_CONTRACT_INCOMPLETE` 文案 | 用例断言 `code` + `assert.match(reason, /PRD\.md 不存在/)` | 已验 |
| R-6 非 CHG 仓库不受影响 | §1.8 / §1.9 | 保留 `tasks/` + `CHG-*` 适用性判据 | 既有「项目适用性」用例保持绿 | 已验 |
| R-7 既有 11 个 CHG 不被误杀 | §1.9 | 默认 allow-list 与 markers | `auditChgContract` 跑真实 fs：11 旧 + 1 新 = 12 个目录全部 `ok`，不通过数 0 | 已验 |
| 探针降级 | §1.7 | `auditChgContract` 对 `isFile`/`readText` 缺失的处理 | 「三项配置清空→回退旧语义」用例（`fs` 无 `readText`） | 已验 |
| 清空配置回退旧语义 | §1.8 | 三个新配置项为空数组时退化为旧行为 | 「三项配置清空 → 回退旧语义」 | 已验 |
| HARD_CHECKS 不变 | §1.10 | `HARD_CHECKS` 集合 | 既有「cap: safety checks keep running」用例 | 已验 |
| 两端探针能力对齐 | — | pi `realFs.readText` / dsh `realFs.readText` 均存在 | `grep -n readText bridge/gates/{pi,dsh}/index.js` 各自命中 | 已验 |

## 独占清单核对（防越界）

- [x] `bridge/gates/policy.js` — 仅本 CHG 修改
- [x] `bridge/test/gate-policy.test.js` — 仅追加 + 修正固化漏洞的旧用例
- [x] `bridge/gates/pi/policy.json` — 仅本 CHG 修改（声明新配置 + 提醒文案 + 版本）
- [x] `bridge/gates/dsh/policy.json` — 仅本 CHG 修改（同上）
- [x] `docs/USAGE.md` — 仅本 CHG 修改（新增一条默认值说明）
- [x] `skills/agent-hard-gates/SKILL.md` — 仅本 CHG 修改（门控表一行）
- [x] `tasks/CHG-20261116-chg-contract-integrity/**` — 本 CHG 自己的四件套
- [x] `bridge/gates/pi/index.js` — **零改动**
- [x] `bridge/gates/dsh/index.js` — **零改动**
- [x] `bridge/lib/**` — **零改动**

## 已知残留缺口（本次不做，如实登记）

| # | 缺口 | 为什么不修 | 后续条件 |
|---|---|---|---|
| G-1 | 不校验「目标文件在该 CHG 的独占文件清单里」 | 清单是自然语言表格（`- `bridge/x.js` — 仅本 CHG 修改`），正则解析必误伤；误杀的代价高于漏放 | 若将来把清单改成机器可读格式（如 frontmatter YAML 数组），可再升级 |
| G-2 | 不校验「读过的契约就是本次要改的那个 CHG」 | 需要在 SPEC 里声明代码范围（glob），当前无此字段；仅能保证「本项目 + 齐全 + 有验收 + 状态可开工」 | 引入 `owned_globs` 字段后可升级为精确绑定 |
| G-3 | 不阻止「补一个空 PRD.md 凑数」 | 门控校验存在性 + 关键词，无法校验思想质量；靠人工复核与 TRACEABILITY 兜底 | 无（本质不可自动化） |
| G-4 | 不校验 CHG 状态机流转 | 超出范围，且容易把「改一行文档补状态」变成新死锁 | 若引入 CHG 状态工具再评估 |
