# ADR-002 — 按 agent 选择接管（opt-in）与可撤回（revoke）

```yaml
adr: 002
change_id: CHG-001
status: proposed        # 随 SPEC v2 批准一同生效
date: 2026-09-27
deciders: [user]
supersedes: ADR-001 的"权威源覆盖全部 agent"表述
```

## 背景

ADR-001 的初版设计把 Claude Code 当作**全部** agent 的权威源，默认接管所有已安装的目标端。

用户否决了这个前提，原话是：

> "我不需要你把 claudecode 配置作为全部所有 agent 的权威来源……pi、codex 必须要独立写……项目我觉得要有选择，就是让用户去挑选，到底要把 claudecode 的配置作为哪个 agent 的权威全局配置源，一定不能一刀切，一定要有用户选择的过程。"
>
> "项目设计上随时可以撤回某个 agent 的全局配置为他自身的原生配置。"
>
> "claudecode 作为权威配置源的同时，仍然会保留其他 agent 自身特有的某些配置。"

因此需要把"默认全接管"改成"默认不接管 + 显式选择 + 可撤回"。

## 决策

### 1. 三态模型，默认最保守

| 状态 | 含义 | 本项目的行为 |
|---|---|---|
| `native` | **默认**。该 agent 使用自己的原生全局配置 | 一个字节都不改 |
| `bridged` | 用户显式 `adopt` 过 | 受管清单内的文件跟随权威源 |
| `revoked` | 曾桥接、已撤回 | 恢复原生配置，保留一条记录备查 |

状态存放在仓库检出目录内的单一文件 `<repo>/.bridge/state.json`（`.gitignore` 已排除）。
**状态文件缺失 = 全部 native**（安全默认）。**状态文件损坏 = 拒绝一切写操作**（不是猜，不是重置）。

> 为什么不放 `~/.config` 或 `~/.local/state`：状态、快照、备份跟着仓库走，换目录、容器重起（只要挂载了该目录）都还在，也不会在别处再堆一堆 `.xxx` 目录。代价是删仓库就丢状态，所以 `doctor` 会直接输出状态文件位置与快照数量。仓库外只剩一个文件：`~/.config/agent-config-bridge/secrets.env`（真实凭据）。

### 2. 选择与撤回是两个显式动作

```
adopt <agent>  :  落快照 → 置 bridged → 首次同步
revoke <agent> :  校验快照 → 按快照反向恢复 → 置 revoked
plan/apply/diff:  只作用于 bridged 的 agent；其余打印"未接管，跳过"
```

两者都需显式授权（SPEC §9），不接受"顺手帮你 adopt 一下"。

### 3. adopt 时先快照，revoke 靠快照真恢复

快照内容（仓库外，权限 700）：

```
<repo>/.bridge/snapshots/<agent>/<snapshot_id>/
  manifest.json     # 每个将被接管的路径 → 动作(created | overwritten | removed) + 原 sha256
  files/            # 仅 overwritten / removed 两种动作才拷原文件
```

* `manifest.json` 是 revoke 的唯一执行依据；
* revoke 前逐项校验 sha256 与存在性，**任一缺失即拒绝执行**（不做"尽力而为"的恢复）；
* revoke 自身也先备份当前状态，所以可以"撤回后再撤销撤回"。

**为什么不做成"只删本项目新增的文件"？** 因为桥接会覆盖目标端已有文件（比如它自己的规则文档），只删新增文件无法还原被覆盖的内容——那不叫撤回，叫留下残骸。

### 4. 桥接只覆盖"共享维度"，私有配置永不在清单内

受管清单（`bridge/targets/*.json` 的 `managed`）只允许出现共享维度：

skills、命令/提示词模板、子 agent 定义、全局规则文档、MCP 条目。

每个目标端还必须显式声明 `never_touch`（本端私有、永不接管），例如：

* pi：`~/.pi/agent/settings.json`、`~/.pi/agent/extensions/`、`~/.pi/agent/auth.json`、`~/.pi/agent/sessions/`
* Codex：`~/.codex/auth.json`、`~/.codex/history.jsonl`
* Gemini：`~/.gemini/oauth_creds.json`

`doctor` 校验 `managed` 与 `never_touch` **不得重叠**，重叠即报错。

### 5. MCP 条目用双向白名单，不碰用户自有 server

目标端的 MCP 配置里可能同时有"用户自己加的 server"和"由权威源派生的 server"。

* 首次 adopt：目标端 MCP 段整体进快照；
* 之后同步：只覆盖"派生集合 ∩ 已登记集合"；
* 用户后来自己新增的 server → 不动；
* 权威源删掉的 server → 同步时从目标端移除（唯一允许的删除动作，且仅在 bridged 状态、白名单内）。

## 被否方案与理由

### 方案 A：默认接管全部 agent，靠 `--exclude` 排除

* 否决原因：**默认值错了**。默认接管意味着用户装完工具，一次误跑 `apply` 就可能改掉 5 个 agent 的配置。安全默认必须是"什么都不做"。
* 处置：改为 opt-in。

### 方案 B：撤回 = 只删除本项目新增的文件

* 否决原因：无法还原被覆盖的原有内容（规则文档、同名 skill），用户会以为已还原而实际没有，属于**伪安全**。
* 处置：改为快照式真恢复 + 快照不完整即拒绝。

### 方案 C：把状态写在各目标端目录里（如 `.bridge-state.json`）

* 否决原因：污染目标端目录（且本项目的初衷就是不要再往家目录里撒点目录），目标端工具也可能因未知 JSON 文件报警或清理；快照与备份也需要一个统一位置来做保留策略。
* 处置：统一放仓库检出目录内的 `.bridge/`（`.gitignore` 排除）；配置类文件仍放 `~/.config/agent-config-bridge/`。

### 方案 D：撤回时把该 agent 的目录整目录删掉重建

* 否决原因：会一并删除用户的私有配置与运行时数据（认证、历史），破坏性远超撤回语义。
* 处置：只在受管清单 + 快照 manifest 记录的路径上操作。

## 后果

### 正向

* 用户可以对 `pi`、`codex` 保持完全独立，只让 `gemini`、`kimi` 跟随 Claude Code；
* "撤回"是可信的：有快照、有校验、有演练要求；
* 私有配置的边界是**可审计的声明**（`managed` / `never_touch` 两份清单），不是代码里的隐式判断；
* 默认零动作把误伤概率降到最低。

### 负向 / 需接受

* 多了一层状态机与快照管理，实现量比"无脑镜像"大（因此 SPEC 把 M2 单独立为一个里程碑）；
* 用户需要理解三态语义（README 用状态图 + 一张表说明）；
* 快照占磁盘（只对 overwrite 类存原文件，且每 agent 保留最近 5 份，可控）。

## 相关

* `tasks/CHG-001/PRD.md`（v2）、`SPEC.md`（v2）、`CHANGE.md`
* `docs/ADR/001-bridge-architecture.md`（底层机制：复制而非软链、密钥外置、零依赖）
