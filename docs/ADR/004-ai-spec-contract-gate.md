# ADR-004 — ai-spec 契约门控（`chg-contract-before-edit`）

```yaml
adr: 004
change_id: CHG-002
status: accepted
date: 2026-10-29
deciders: [user]
```

## 背景

`AGENTS.md` 里「按 CHG 推进、先契约后开发」是**建议**。实测事故（xuanji 项目 2026-10-29，
40 个 CHG 批量开发）：

| 现象 | 数量 |
|---|---|
| CHG 缺 `PRD.md` | 31 / 40 |
| CHG 缺 `TRACEABILITY.md` | 28 / 40 |
| 先合并的 CHG 用「全局状态断言」把后合并的合法改动判红 | 8 处 |

8 处断言冲突的根因完全一致：`assertEqual(len(rules), 2074)` 这类**写死全局状态**的断言，
在别的 CHG 合法新增规则后必然变红 —— 这不是实现错，是「没先核对契约边界就动手」。

另有一次「补文档」交付：脚本生成骨架 + 大量 `TODO(ai-spec)` 占位，等于**声称就绪而实际空壳**，
正好撞在 ai-spec 的 `Do not claim readiness when information is missing` 上。

结论：**契约核对不能靠自律，必须落成硬门控。**

## 决策

在 `bridge/gates/policy.js` 新增 check：`chg-contract-before-edit`。

| 项 | 决策 |
|---|---|
| 触发 | `action === 'write'` 且目标是代码文件（`isCodeFile`） |
| 判定 | `state.docReads` 里必须有一条落在 `chg_contract_globs` |
| 硬性 | 加入 `HARD_CHECKS`，**不因拦截上限而失效**（与安全项同级） |
| 范围 | **只约束代码**：改文档 / 数据 / 台账不要求 CHG 契约 |
| 开关 | `config.require_chg_contract`，默认 `true` |
| 默认 glob | `**/tasks/chg-*/{spec,prd,change,traceability}.md` |

### 与 `think-before-write` 的分工（两者都要过）

```
think-before-write       → 你看过这个文件吗？（证据层）   缺 = 篡改
chg-contract-before-edit → 这改动属于哪个 CHG？契约齐全吗？（契约层） 缺 = 跑偏
```

### 拦截文案（内嵌 5 问自检）

1. 这个改动属于哪个 CHG？（答不出 = 不许改）
2. 该 CHG 四件套齐全吗？（缺哪件就先补，缺料不许开工）
3. 目标文件在该 CHG 的「独占文件」清单里吗？（不在 = 可能越界）
4. 改完哪条 AC 会从红变绿？（答不出 = 没有验收目标）
5. 是先用第一性原理判了根因，还是照症状打补丁？

并明确写入：**开发中发现的问题必须当场修，不许留给「后续」；收尾必须让该 CHG 的预定功能目标达成，而不是「大部分做完」。**

## 关键实现细节（踩过的坑）

> **glob 必须全小写。**

`normalizePath` 会把路径**小写化**（Windows 下还转反斜杠），而 `matchesAnyGlob` 之前会
`toPosix`。所以写成 `**/tasks/CHG-*/SPEC.md`（大写）**永远不会匹配** —— 门控会静默失效，
看起来装了其实没拦。

这个坑是测试抓出来的：`test('ai-spec: 改代码前未读 CHG 契约则拦…')` 首轮在
「读过 SPEC 即放行」这一步变红，才暴露出 glob 大小写问题。**该断言因此必须保留。**

## 后果

- 改任何代码前，本会话必须读过 `tasks/CHG-*/SPEC.md`（一次即够，session 级）
- 未读时阻断并给出 5 问清单
- 非代码文件（文档 / 数据 / 台账）不受约束，不会卡住纯文档维护
- `dsh` 适配层未启用该 check（其 `policy.json` 的 `checks` 不含它），故不受影响
