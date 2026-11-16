---
change_id: CHG-20261116-chg-contract-integrity
version: 1
status: approved
prd_ref: PRD.md
created: 2026-11-16
owner: Owner
---

# SPEC-20261116 · CHG 契约门控升级为「契约成立」

## 1. 目标（可判定终态）

1. **契约必须齐全**：命中的那份契约所在目录，必须同时存在
   `chg_contract_required_files`（默认 `SPEC.md` / `PRD.md` / `TRACEABILITY.md`）。
   缺任意一件 → 拒绝，并在原因里逐条列出缺哪一件。
2. **SPEC 必须有验收判据**：`SPEC.md` 正文命中 `chg_acceptance_markers`
   （默认 `验收` / `AC-` / `断言` / `可判定` / `Acceptance`）之一，否则拒绝。
3. **契约 status 必须可开工**：`SPEC.md` frontmatter 的 `status` / `state` 字段
   若存在，必须命中 `chg_status_allow`（默认 `approved` / `executing` / `active` /
   `in-progress` / `in_progress`）；`draft` 之类一律拒绝。**字段缺失不拦**——
   不同仓库的 frontmatter 写法不同，格式差异不该变成死锁。
4. **契约必须属于当前项目**：`docReads` 里的契约路径必须落在
   `scope.projectRoot ?? scope.root` 之下才计入。读别的仓库的 CHG 不给解锁。
5. **判定取「一份成立的契约」而非「任一份」**：遍历本会话读过的、属于本项目的
   所有 CHG 目录，只要**有一个**同时满足 1~3 即放行；全部不满足则拒绝，
   并把每个候选目录的问题合并报告。
6. **区分两种拒绝码**：
   - 没读过任何本项目契约 → `CHG_CONTRACT`（原有码，文案保留并补充新要求）；
   - 读过但契约不成立 → `CHG_CONTRACT_INCOMPLETE`（新码，逐条列出缺口）。
7. **探针能力降级**：若调用方只提供 `exists`（无 `isFile` / `readText`），
   只校验齐全性，不因「读不到内容」而拦——不把测试桩的能力缺失算成模型的错。
8. **向后兼容**：`require_chg_contract: false` 时整条检查关闭，行为与旧版一致；
   `chg_contract_required_files: []` 且 `chg_acceptance_markers: []` 且
   `chg_status_allow: []` 时退化为旧版「读过即放行」。
9. **不误杀既有仓库**：本仓现有 11 个 `tasks/CHG-*/SPEC.md` 全部
   `status: approved` 且验收段命中 ≥6 次，新判据不得让任何一个变成红。
10. **`HARD_CHECKS` 不变**：`chg-contract-before-edit` 继续留在硬名单，
    不受 `max_blocks_per_session` 上限影响。

## 2. 验收断言

| # | 断言 | 验收方式 |
|---|---|---|
| AC-1 | 只写/只读 `SPEC.md`（缺 PRD、TRACEABILITY）→ 改代码被拦，code=`CHG_CONTRACT_INCOMPLETE` | `gate-policy.test.js`「契约不齐不许开工」 |
| AC-2 | 四件套齐全但 SPEC 无验收判据 → 被拦，原因含「验收判据」 | 「SPEC 没有验收判据要拦」 |
| AC-3 | 四件套齐全、有验收判据，但 `status: draft` → 被拦 | 「draft 状态不许开工」 |
| AC-4 | `status` 字段缺失但齐全且有验收判据 → 放行（不误杀） | 「缺 status 字段不拦」 |
| AC-5 | 本项目未读契约，只读了**其他仓库**的 `CHG-*/SPEC.md` → 仍 `CHG_CONTRACT` | 「跨仓库契约不给解锁」 |
| AC-6 | 本项目读过一份成立的契约 → 放行 | 改写原「读过 SPEC 即放行」用例 |
| AC-7 | `require_chg_contract: false` → 不拦 | 既有用例保持 |
| AC-8 | 无 `tasks/` 或无 `CHG-*` 子目录 → 不拦 | 既有「项目适用性」用例保持 |
| AC-9 | 全配置清空时退化为旧行为（读过即放行） | 「清空配置回退旧语义」 |
| AC-10 | `node --check` + `node --test` 全绿，`scan-secrets.sh` 无命中 | CI 三步 |

## 3. 独占文件清单

- `bridge/gates/policy.js` —— 仅本 CHG 修改
- `bridge/test/gate-policy.test.js` —— 仅追加用例 + 修正固化漏洞的旧用例
- `tasks/CHG-20261116-chg-contract-integrity/**` —— 本 CHG 自己的四件套
- `bridge/gates/pi/index.js` —— **零改动**
- `bridge/gates/dsh/index.js` —— **零改动**
- `bridge/lib/**` —— **零改动**

## 4. 绝不做什么

1. **不解析「独占文件清单」**：它是自然语言表格，正则解析必误伤。本次不做，
   在 TRACEABILITY 里登记为残留缺口。
2. **不要求 `CHANGE.md` 必存在**：它是立项叙事，不是判据载体；历史 CHG 命名也不统一。
3. **不引入 CHG 状态机**（draft → approved → executing → done 的流转校验）：
   超出本次范围，且容易把「改一行文档补状态」变成新的死锁。
4. **不改成软提醒**：这条检查守的是「不跑偏」，与安全同级，必须保持硬拦。
5. **不动 `isChgContract` 的 glob 语义**：大小写不敏感是踩过坑修好的（配置全小写导致静默失效），
   本次不碰。
