# 里程碑路线图

> 工程契约见 `tasks/CHG-001/SPEC.md` 第 5 节。本文件只用来"照着做、做完打勾"。

## 顺序与依赖

```
M1 骨架/安全地基/状态层
 └── M2 adopt-revoke 状态机与快照
      └── M3 文件类桥接（skill/command/agent/rules-doc）
           └── M4 MCP 跨格式派生 + 密钥外置
                └── M5 doctor / rollback / 可观测
                     └── M6 文档闭环 + 脱敏终检 + 真机端到端
```

不可跳阶：M2 没做完就不做 M3 —— 否则会出现"能同步但不能撤回"的半成品，比不做更危险。

## M1 骨架 / 安全地基 / 状态层

- [ ] `bridge/cli.js` 命令分发 + 参数解析 + 退出码（0/1/2/3）
- [ ] `bridge/lib/paths.js`（`os.homedir()`、源根、状态与快照目录）
- [ ] `bridge/lib/log.js`（含 `redact()` 屏蔽长 token）
- [ ] `bridge/lib/state.js`（读/写/检测损坏；缺失→全 native，损坏→拒写）
- [ ] `bridge/lib/plan.js`（变更计划数据结构）
- [ ] `scripts/scan-secrets.sh`（8 类模式 + 窄豁免 + `--staged` / `--history`）
- [ ] `.gitignore`、`templates/secrets.env.example`
- [ ] `node --test` 骨架

**完成判定**：`node bridge/cli.js status` 在无状态文件时输出"全部 native"，退出 0；扫描脚本 0 命中。

## M2 adopt / revoke 状态机与快照

- [ ] `bridge/lib/snapshot.js`：落盘、manifest、sha256 校验、保留最近 5 份
- [ ] `bridge/lib/adopt.js`：落快照 → 置 bridged（此阶段只改状态）
- [ ] `bridge/lib/revoke.js`：校验快照 → 反向恢复 → 置 revoked
- [ ] 测试：缺失/损坏状态、快照被删、部分文件缺失

**完成判定**：`node --test` 全绿；真机 adopt 后 `status` 显示 bridged；删掉快照里一个文件后 `revoke` 明确报错拒绝执行。

## M3 文件类桥接

- [ ] `bridge/lib/scan-source.js`（发现权威源的 skill/command/agent）
- [ ] `bridge/lib/manifest.js`（解析 `bridge/targets/*.json`，校验 managed ∩ never_touch 为空）
- [ ] `bridge/lib/fs-ops.js`（复制、备份、权限、fail-fast）
- [ ] `bridge/lib/render.js`（frontmatter 适配）
- [ ] 四个目标端清单：`pi.json` / `codex.json` / `gemini.json` / `kimi.json`
- [ ] `plan` / `apply` / `diff` 全通，**仅对 bridged 生效**

**完成判定**：真机 `plan` → `apply` → `diff`(0) → 再 `plan`(0 变更)；未 adopt 的 agent md5 全量不变。

## M4 MCP 跨格式派生 + 密钥外置

- [ ] `bridge/lib/mcp/read-source.js`
- [ ] `emit-pi.js` / `emit-codex-toml.js` / `emit-gemini.js` / `emit-kimi.js`
- [ ] `bridge/lib/secrets.js`（`${VAR}` 展开、缺失 fail-closed）
- [ ] 双向白名单：用户自有 MCP 条目保留的测试
- [ ] 产物 `chmod 600`

**完成判定**：fixture 往返单测通过；"用户自有条目保留"用例通过；真机转换后人工核对记录归档。

## M5 doctor / rollback / 可观测

- [ ] `bridge/lib/doctor.js`：状态一致性、清单冲突、目录与权限、占位符残留、敏感模式、快照完整性、软链检测、陈旧度
- [ ] `bridge/lib/rollback.js`
- [ ] `last-apply.json` 落盘
- [ ] error / warn 分级与 `--strict` 语义

**完成判定**：人为制造漂移 → `doctor` 非 0；删除 bridged agent 一个 skill → `apply` 恢复且其他 agent md5 不变。

## M6 文档闭环 + 脱敏终检 + 端到端

- [ ] `README.md`（状态图 + 会桥接什么/不会碰什么表）
- [ ] `docs/USAGE.md`
- [ ] `docs/ADR/001`、`docs/ADR/002`
- [ ] `CONTRIBUTING.md`
- [ ] `tasks/CHG-001/TRACEABILITY.md` 回填证据
- [ ] `bash scripts/scan-secrets.sh --history` 0 命中
- [ ] 真机端到端演练记录（status → adopt → plan → apply → diff → revoke → 快照比对）

**完成判定**：SPEC §6 DoD 逐条打勾且每条可复现。

## 真机演练脚本（M6 用）

```bash
node bridge/cli.js status
node bridge/cli.js adopt <试点端>
node bridge/cli.js plan
node bridge/cli.js apply
node bridge/cli.js diff                 # 期望 0 漂移
node bridge/cli.js plan                 # 期望 0 变更（幂等）
md5sum <未 adopt 端的任一配置文件>       # 记录
node bridge/cli.js revoke <试点端>
node bridge/cli.js status
md5sum <未 adopt 端的任一配置文件>       # 应完全一致
```

演练记录（命令 + 输出 + 时间）写入 `tasks/CHG-001/TRACEABILITY.md` 的证据列。
