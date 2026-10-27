---
change_id: CHG-20261031-gate-skill-bootstrap
delivery_status: delivered
generated_by: manual
---

# TRACEABILITY · AC → 证据（实测）

| AC | 实现位置 | 证据 | 破坏方式 |
|---|---|---|---|
| AC-1 | `scripts/bootstrap.js` detect | `bootstrap.test.js`「a machine without ~/.pi fails loudly」通过（非 0 + 明确报错） | 静默跳过 |
| AC-2 | `scripts/bootstrap.js` plan | 「dry-run prints a plan and writes nothing」通过（无 `extensions`、无技能目录） | 加写盘 |
| AC-3 | adopt/apply 调用 | 本机实跑：`apply pi: +0 ~3` → 校验通过；policy `version=4`、`checks` 含 `graph-before-read` | 跳过 apply |
| AC-4 | `install-hard-gate-skill.js` | 「first run adds, second run keeps」通过 | 无条件覆盖 |
| AC-5 | 技能安装路径 | 实跑：`~/.claude/skills/agent-hard-gates/SKILL.md` 存在；`~/.agents/skills/agent-hard-gates` 可读（链接共享） | 复制两份 |
| AC-6 | README / USAGE | `scan-secrets.sh --all` OK；新增 Windows/Linux 同一套 node 命令 | 写入真实值 |
| AC-7 | 文档路径规范 | 同上；全文使用 `~/` 与 `<占位符>`，无真实家目录/用户名 | 写死用户名 |
| AC-8 | — | `node --test`：195 tests / 193 pass / 0 fail / 2 skipped | 任一失败 |

## 部署记录

```
node scripts/bootstrap.js --yes --root <dev-root> --root <home>/mcp
→ apply pi: +0 ~3 -0 (kept 53)
→ 校验通过：checks = no-write-outside,...,no-blind-retry
→ 技能 installed
→ 机器作用域已创建（随后修正顺序并重新 apply，project_roots 正确合并）
```

## 备注

- 首次 `--yes` 运行时机器配置在 apply 之后创建，导致部署策略的 `project_roots` 为空；已把「写机器配置」移到 apply 之前，重新 apply 后核对为 `["<dev-root>","<home>/mcp"]`。
- 技能冲突策略为「默认保留用户版本」，与 PRD 的 P-5 一致。
