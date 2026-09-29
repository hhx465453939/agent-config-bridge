# 里程碑路线图

> 工程契约见 `tasks/CHG-001/SPEC.md` 第 5 节。本文件只用来"照着做、做完打勾"。

## 顺序与依赖

```
M1 骨架/安全地基/状态层
 └── M2 adopt-revoke 状态机与快照
      └── M3 文件类桥接（skill/command/agent/rules-doc）
           ├── M4 MCP 跨格式派生 + 密钥外置
           └── M5 硬闸门（gate）抽象与铺开
                └── M6 doctor / rollback / 可观测
                     └── M7 文档闭环 + 脱敏终检 + 真机端到端
```

不可跳阶：M2 没做完就不做 M3 —— 否则会出现"能同步但不能撤回"的半成品，比不做更危险。
M5 依赖 M3（闸门要走同一套受管路径才能被快照），但不依赖 M4。

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

## M5 硬闸门（gate）抽象与铺开

- [ ] `bridge/gates/policy.js`：策略层（纯逻辑，零 harness 依赖）
- [ ] `bridge/gates/pi/{index.js,policy.json}`：pi 适配层
- [ ] `bridge/gates/dsh/{index.js,policy.json}`：DeepSeek Harness 适配层
- [ ] `bridge/lib/gates.js`：安装规划（生成 policy.json、README、目录入口）
- [ ] 清单 `gates` 块校验 + `never_touch` 的窄豁免（只免闸门自己那个子目录）
- [ ] `status` 报告每个端的闸门状态（已装/未装/不支持 + 是否需要手动挂载）
- [ ] `bridge/test/gates.test.js`

**完成判定**：`node --test` 全绿；沙箱里 adopt 装上闸门、`diff` 幂等、revoke 连目录一起恢复且不碰用户自己的扩展。

## M6 doctor / rollback / 可观测

- [ ] `bridge/lib/doctor.js`：状态一致性、清单冲突、占位符残留、敏感模式、快照完整性、软链、陈旧度、**声明的运行时依赖是否存在**（ADR-004）
- [ ] `bridge/lib/rollback.js`
- [ ] `last-apply.json` 落盘（`<repo>/.bridge/`）
- [ ] error / warn 分级与 `--strict` 语义

**完成判定**：人为制造漂移 → `doctor` 非 0；快照不完整 → `doctor` 非 0 且 `revoke` 拒绝执行；把 pi-mcp-adapter 移走 → `doctor` 报 `REQUIREMENT_MISSING`（warn，`--strict` 下非 0），装回来即消失。

## M7 文档闭环 + 脱敏终检 + 端到端

- [ ] `README.md`（状态图 + 会桥接什么/不会碰什么表 + 硬闸门一节）
- [ ] `docs/USAGE.md`
- [ ] `docs/ADR/001`、`docs/ADR/002`、`docs/ADR/003`、`docs/ADR/004`
- [ ] `CONTRIBUTING.md`
- [ ] `.github/workflows/ci.yml`（`node --test` + 敏感扫描）
- [ ] `tasks/CHG-001/TRACEABILITY.md` 回填证据
- [ ] `bash scripts/scan-secrets.sh --history` 0 命中
- [ ] 真机端到端演练记录（status → adopt → plan → apply → diff → revoke → 整树比对）

**完成判定**：SPEC §6 DoD 逐条打勾且每条可复现。

## 真机演练脚本（M7 用）

下面全部在**沙箱**里跑（`bridge/test/sandbox.js` 会把机器上的 `.xxx` 目录复制进临时目录，跑完整个临时目录一起删掉）。**不碰本机真实配置。**

```bash
# 1. 全套自动化检查
node --test
bash scripts/scan-secrets.sh --history

# 2. 一次性人工演练（临时目录，可重复跑）
node -e "
  import('./bridge/test/sandbox.js').then(async (m) => {
    const api = await import('./bridge/lib/api.js');
    const sb = m.makeSandbox({ install: ['pi', 'kimi', 'dsh'] });
    const quiet = { info(){}, say(){}, ok(){}, warn(){}, error(){}, payload(){} };
    console.log('1 status ', api.status(sb.repo, sb.home).agents.map(a => a.name + ':' + a.status).join(' '));
    api.adopt({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    console.log('2 adopt  pi ->', api.status(sb.repo, sb.home).agents.find(a => a.name === 'pi').status);
    console.log('3 diff   ', JSON.stringify(api.diff({ repo: sb.repo, home: sb.home }).targets.filter(t => !t.skipped).map(t => [t.name, t.actions.length])));
    api.revoke({ repo: sb.repo, home: sb.home, names: ['pi'], log: quiet });
    console.log('4 revoke pi ->', api.status(sb.repo, sb.home).agents.find(a => a.name === 'pi').status);
    sb.cleanup();
  });
"

# 3. 第 3 步期望输出 [['pi',0]]（0 变更 = 幂等）
# 4. 第 4 步之后被 adopt 端的目录树应与 adopt 前一致（单测已断言）
```

> 真机上跑之前，先 `node bridge/cli.js status` 看一眼。真要 adopt 时，**建议先用一个"毁掉也不心疼"的端试**。本机实测记录留空，等用户授权后填。
