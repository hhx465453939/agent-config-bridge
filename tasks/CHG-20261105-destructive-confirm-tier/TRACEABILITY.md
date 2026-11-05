---
change_id: CHG-20261105-destructive-confirm-tier
delivery_status: delivered
generated_by: manual
---

# TRACEABILITY · PRD → SPEC → AC → 证据（实测）

## PRD → SPEC → AC

| PRD | SPEC 目标 | AC |
|---|---|---|
| P-1 普通删除不再一律拒绝 | §1.2 / §1.4 | AC-1、AC-1b |
| P-2 不可恢复的仍硬拦 | §1.3 | AC-2、AC-3、AC-7、AC-10、AC-10b |
| P-3 交互模式真的问一句 | §1.5 | AC-11、AC-20 |
| P-4 自动化不被确认卡死 | §1.6 | AC-11c |
| P-5 可回退 | §1.8 | AC-8 |
| P-6 两端一致 | §1.7 | AC-12、AC-13 |
| P-7 红线 / 可授权两层 | §11.1 | AC-15、AC-2、AC-3 |
| P-8 七个类别三档 | §11.1 / §11.2 | AC-4、AC-5、AC-16、AC-17 |
| P-9 随时提权/降权 | §11.3 | AC-20、AC-21 |
| P-10 agent 不能自我提权 | §11.3 | AC-18 |
| P-11 收紧优先 | §11.2 | AC-17 |

## AC → 实现位置 → 证据（实测通过的用例）

策略层（`bridge/test/gate-destructive.test.js`）：

| AC | 实现位置 | 证据（用例名） |
|---|---|---|
| AC-1 / AC-1b | `policy.js::bashDestructiveFinding` rm 分支 + `unrecoverableTarget` | 「permission: deleting a named file or data dir is a confirm, not a refusal」 |
| AC-2 | `unrecoverableTarget` 的 `$HOME` 及祖先分支 | 「guardrail: $HOME and its ancestors stay unrecoverable under any grant」 |
| AC-3 | `unrecoverableTarget` 的 cwd 及祖先分支 | 「guardrail: the cwd and its ancestors stay unrecoverable」 |
| AC-4 / AC-5 | `bashDestructiveFinding` git 分支（`git-history` / `git-force-push` 分开） | 「permission: git history rewrites are a grantable category」「permission: force push is its own category, so it can be granted separately」 |
| AC-6 | `isDisposablePath` 既有语义 | 「allow tier: build output still runs without asking (no regression)」 |
| AC-7 | `unrecoverableTarget` 的原始 token `..` 判定 | 「guardrail: a `..` segment is high even when normalize() would collapse it」 |
| AC-8 | `no-destructive-bash` 的 `destructive_confirm_mode === false` 分支 | 「rollback switch: destructive_confirm_mode:false blocks the ask tier again」 |
| AC-9 | `shouldBlock` 的 `verdict.confirm` 早返回 | 「block cap: a confirm is not a block, and both security checks stay hard」 |
| AC-10 | `unrecoverableTarget` 的段数 ≤1 判定 | 「guardrail: top-level directories are high; /tmp paths stay disposable」 |
| AC-10b | `HOST_DESTRUCTIVE_VERB` / `RAW_DEVICE` / 关机分支 | 「guardrail: disk, raw device and host destruction stay unrecoverable」 |
| AC-10c | 嵌套 shell 递归 | 「guardrail: a nested shell cannot smuggle one past the gate」 |
| AC-10d | `isGitRepo` 注入 | 「guardrail: an injected git-repo probe makes a non-ancestor repo root high」 |
| AC-15 | guardrail 在 tier 判定之前返回 | 同上「…under any grant」（全类别 allow 仍拦） |
| AC-16 | `DEFAULT_CONFIG.destructive_grants['db-ddl'] = 'deny'` | 「permission: db-ddl starts at deny because a dropped schema outlives most backups」 |
| AC-17 | `effectiveDestructiveTier` 的不对称优先级 | 「permission: tightening beats loosening」 |
| AC-18 | `no-self-grant` 检查 | 「self-grant: a write that carries destructive_grants is refused」「…an ordinary edit of the same file is still allowed」「…a shell redirect at the same file is refused」 |
| AC-19 | `applyMachineOverride` | 「override: a grant written to the machine file takes effect」「…an unknown category or a bad tier is ignored, not applied」「…a broken file leaves the shipped policy standing」 |

适配层：

| AC | 实现位置 | 证据（用例名） |
|---|---|---|
| AC-11 / AC-20 | `pi/index.js` `ctx.ui.select` 三选一 | 「pi: allow-once proceeds and asks exactly once」「pi: reject blocks the call」「pi: dismissing the dialog is a refusal, not an approval」「pi: "allow this class" suppresses the question for the rest of the session」 |
| AC-11c | `pi/index.js` 无 UI 分支 | 「pi: no UI runs the ask tier and records the decision」 |
| AC-11d | guardrail 在弹窗之前返回 | 「pi: a guardrail blocks without asking, even when everything is granted」 |
| AC-21 | `pi/index.js` `/gate` 命令 | 「pi: /gate list reports every category and the red lines」「pi: /gate grant writes the machine file and rejects unknown categories」 |
| AC-22 | `registerCommand` 能力防御 | 由 22 个既有 adapter 用例同时转绿证（见「现场证据 1」） |
| AC-12 | `dsh/index.js` confirm → `next()` | 「dsh: guardrails deny, permissions delegate, denies refuse」「dsh: the rollback switch and category grants both hold」 |
| AC-13 | 两端 `policy.json` | 「config: both shipped policies declare the grants and the self-grant guard」 |

## 现场证据（不是计划绿）

1. **`pi.registerCommand is not a function` 一次性打红 22 个既有用例**。根因不是测试桩过时，
   而是扩展对宿主能力做了硬假设：旧版 pi 或缺少命令 API 的宿主会让整个 `enforceRules()`
   在注册命令时抛错——**门控连同安全层一起失效**。修法是能力探测后再注册
   （`typeof pi.registerCommand === 'function'`），只丢 `/gate`，不丢安全层。这是本 CHG 里
   最有价值的一次失败：它证明了「加功能」可以直接打掉「安全底线」，而 CI 抓到了。
2. **`policy.json` 漏写 `destructive_grants`**：只有 `DEFAULT_CONFIG` 有表，用户打开配置文件看不到。
   测试「config: both shipped policies…」直接报 `Cannot read properties of undefined`，当场补上。
3. **`HARD_CHECKS` 期望集合排序踩坑**：`[...HARD_CHECKS].sort()` 里 `no-secret-write` 排在
   `no-self-grant` 之前（`sec` 的 `c` < `sel` 的 `l`），我按语义顺序写的期望数组因此变红。
   改成按字母序后通过——这类失败说明断言写的是「我脑子里的顺序」而不是「实际契约」。
4. **`git reset --hard` 不能当「真实拦截」样本**：它现在是 `confirm` 档，不消耗 block cap。
   原测试用它验证「真实拦截仍计数」，改成 `drop database`（`db-ddl` 默认 deny）才成立。

## 实测汇总（2026-11-05）

```
# 基线（改动前）
node --test bridge/test/*.test.js   # EXIT=0，222 tests / 221 pass / 0 fail / 1 skipped

# 交付（改动后）
node --test bridge/test/*.test.js   # EXIT=0，258 tests / 257 pass / 0 fail / 1 skipped
```

安装产物端到端验证（独立进程导入 `<extension_dir>/enforce-rules/policy.js`，20 项断言全过）：

```
version 5 | confirm_mode true | grants.delete confirm | grants.db-ddl deny
checks 含 no-self-grant: true | HARD_CHECKS 含 no-self-grant: true | reminder 新文案: true

普通删除 → confirm(delete)        删 $HOME → high + block
删 cwd → block                    含 .. → block
mkfs → block                      裸设备 dd → block
强推 → confirm(git-force-push)    强推授权后 → 放行
reset --hard → git-history        node_modules → allow(null)
db-ddl 默认 → DESTRUCTIVE_DENIED  db-ddl 授权后 → 放行
confirm_mode=false → 回退硬拦      全类别授权后 $HOME 仍拦
自我提权 → GATE_SELF_GRANT
```

## 部署核对

```
node bridge/cli.js apply --targets pi
  pi: +0 ~4 -0 (kept 66)
```

更新的 4 个文件：`policy.js`、`policy.json`、`pi/index.js`、`README.md`。

**生效时机**：门控在会话启动时载入内存，所以本机已在运行的会话仍是旧规则；
新开会话即生效。这是 pi 的加载模型，不是部署缺陷。

## 未覆盖（明确不承诺）

- 不做跨机器授权同步（授权是「机器 + 用户」的属性，不是仓库属性）。
- 不做「永久不再询问」的无限制白名单（授权始终按类别、可随时收回）。
- dsh 端无法调整授权（无命令通道），只能读 `apply` 后的 `policy.json`。
- 不判断「文件是不是 agent 自己创建的」（静态解析不可靠）。

## 部署实测与 v2.1 增量（本机）

部署动作与结果：

```
node bridge/cli.js plan --targets pi   # +4 ~4 -0
node bridge/cli.js apply --targets pi  # +4 ~4 -0（随后 v2.1 再 apply ~1）
node bridge/cli.js diff  --targets pi  # no changes
```

安装副本（`~/.pi/agent/extensions/enforce-rules/`）与源 `policy.js`、`pi/index.js`、
`classifier.js`、`profiles/*.json` sha256 一致；`policy.json` 与 README 是生成物
（前者合并机器 override，后者是安装说明），与仓库公开源有意不同。

对**安装副本**的 20 条功能断言（三选一弹窗、guardrail、授权、自我提权、无 UI 降级）：

```
20/20 passed
```

### v2.1 新增 AC

| AC | 断言 | 反证方式 |
|---|---|---|
| AC-23 | `psql -c` / `mysql -e` / `sqlite3 db` / `mongosh --eval` 携带的 DDL 均判 `db-ddl`；`/gate grant db-ddl` 后放行 | 把 DDL 判定改回只锚定动词 → 红 |
| AC-24 | `psql -c "select 1"`、`psql -f seed.sql`、`echo` 一段 DDL 文本均不产生 finding | 把 DDL 正则改成「全命令任意位置」→ 红（假阳性） |

### 测试独立性（同批修复）

`applyMachineOverride` 会让**测试注入的策略**被本机 `gate-policy.json` 里的
`project_roots` 覆盖，于是同一 commit 在 CI（无该文件）绿、在写门控的这台机器上红
（全量 5 项：`gate-adapter` 2、`gate-ai4s` 2、`gates` 1）。新增 `bridge/test/isolate-home.js`，
由 3 个适配层测试文件副作用导入，把 `$HOME` 指向空临时目录；直接测试 override 自身的
用例仍显式传 `home`，不受影响。修后**在带机器 override 的真实环境下**全量绿：

```
node --test bridge/test/*.test.js   # 259 tests / 257 pass / 0 fail / 2 skipped（未设任何环境变量）
```

### v2.2：边界 vs 项目根（AC-25）

| AC | 断言 | 反证方式 |
|---|---|---|
| AC-25 | 配置边界为开发树、文件在边界内的 git 仓库时：`scope.root === <dev-root>`、`scope.projectRoot === <repo>`，写入未读约定的文件得 `THINK_CONVENTIONS`；读完仓库 `AGENTS.md` 后该规则不再拦；非仓库目录 `projectRoot` 退回边界 | 把 `root` 当作项目根使用（v2.1 及之前）→ 红 |

安装副本实测（真实机器配置）：

```
boundary(root) = <dev-root>；projectRoot = <dev-root>/agent-config-bridge
写入未读约定       -> THINK_CONVENTIONS
读完 AGENTS.md 后  -> CHG_CONTRACT   （同一个根因的第二个失效规则，同时活了）
```

### 部署后的行为变化（告知用户）

本次部署后，之前因同一个根因而静默失效的两条规则开始真的生效：

1. 改代码前需要本会话读过该仓库的约定文档（AGENTS.md / CLAUDE.md / CONTRIBUTING.md / .cursorrules，存在才要求）；
2. 改代码前需要本会话读过该仓库的 `tasks/CHG-*/SPEC.md`（或 PRD.md）。

两条都早就在 `policy.json` 的 `checks` 里声明，不是新增规则；之前不生效是 bug。
需要临时关闭时的合法通道：用户编辑机器本地 `gate-policy.json` 的 `config`（agent 不得自改，`no-self-grant` 只管授权表）。
