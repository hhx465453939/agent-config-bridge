# CHANGE：CHG 契约门控从「读过一份」升级为「契约成立」

- change_id: CHG-20261116-chg-contract-integrity
- 提出人: Owner
- 提出时间: 2026-11-16
- 状态: approved

---

## 0.1 原始需求（Owner 原话）

> 这个项目，有没有对于 pi agent 的 chg 立项方面的门控？今天开发我发现 pi agent 有时候会出现
> chg 立项只写了一个 SPEC.md 以后就开始开发的情况，我要你帮我核查一下，然后想想办法。

## 0.2 现状审计（实测证据）

判据在 `bridge/gates/policy.js` 的 `chg-contract-before-edit`（约 2612 行），全文只有一句判定：

```js
const read = [...deps.state.docReads].some((p) => isChgContract(normalizePath(p), config));
if (read) return null;
```

即「本会话读过 `tasks/CHG-*/{SPEC,PRD,CHANGE,TRACEABILITY}.md` **任意一份**」就放行全部代码改动。
`bridge/test/gate-policy.test.js:354` 把这条语义固化成了断言：`assert.equal(w(docs).block,false,'读过 SPEC 即放行')`。

四个缺口全部命中 Owner 描述的现象：

| # | 缺口 | 证据 |
|---|---|---|
| G1 | 契约不齐也放行：缺 PRD / TRACEABILITY 不影响 | `grep -rn "chg-items\|chg-verify\|executing"` 在 `bridge/` 下 0 命中；无任何齐全性判断 |
| G2 | SPEC 是空壳也放行：没有验收判据、无从判断改完对不对 | 同一处判定只看路径，不读内容 |
| G3 | 契约不绑定仓库：读别的仓库的 CHG 也能解锁本仓库 | 该行**没有** `withinRoot`；对比同文件 `THINK_CONVENTIONS`（2719 行）用了 `withinRoot(root,p)` |
| G4 | 契约不绑定本次改动：读一年前的 `CHG-001/SPEC.md` 就能改今天的代码 | 无日期 / 无 status / 无独占清单判断 |

**复现路径（正是 Owner 看到的形态）**：
1. agent 写 `tasks/CHG-新/SPEC.md` —— 文档写入，`isCodeFile` 为假，门控不管；
2. agent 读刚写的那份 `SPEC.md` —— `recordDocRead` 记录，命中 `chg_contract_globs`；
3. agent 改任意代码 —— `some(...)` 为真，放行。

「只写一个 SPEC.md 就开工」不是 agent 侥幸，是**门控当前只检查了「有没有碰过契约文件」，没有检查「契约是否成立」**。

## 0.3 影响面

- `bridge/gates/policy.js`：`DEFAULT_CONFIG` 增配置、新增辅助函数、重写 `chg-contract-before-edit` 判据。
- `bridge/test/gate-policy.test.js`：改写原「读过 SPEC 即放行」用例（该用例固化的正是漏洞），新增完整性/状态/跨仓库用例。
- 不改任何适配层（pi / dsh 都通过 `shouldBlock` 共享同一判据）。

## 0.4 绝不做什么

- 不引入「SPEC 必须含独占文件清单」的硬解析：清单是自然语言表格，正则解析必然误伤，改为文档记录为残留能力缺口。
- 不改 `HARD_CHECKS`：该检查已经在硬名单里，不受拦截上限影响，保持。
- 不因新增校验而为「不用 CHG 的仓库」引入死锁：`tasks/` 存在且有 `CHG-*` 才启用，保持不变。
