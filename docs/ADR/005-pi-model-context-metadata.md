# ADR-005 — 模型上下文窗口：建一张有出处的表，让 `doctor` 盯着各端的手抄副本

```yaml
adr: 005
change_id: CHG-002
status: proposed
date: 2026-09-30
deciders: [user]
```

## 背景

一次真实事故，现象是「1M 上下文的模型被当成 128K」。

`contextWindow` 在 pi 里**不是装饰性标签**。pi 用它做上下文预算，并据此决定**何时压缩会话**（`DEFAULT_COMPACTION_SETTINGS`）。于是它是一个双向故障点：

* 写小了 → 模型明明有 1M，pi 提前把上下文压掉，能力白扔，且**不报任何错**；
* 写大了 → 请求超限，报错。

pi 正常从 provider 学这个数：`pi-ai` 给每个 provider 发一份 JSON（`dist/providers/data/*.json`）。但这条机制在本机有两个洞，而且**都是活的**：

### 洞 1：自定义网关没有官方数据文件

`code.ciallo.cv`（"shudie"）不是 pi 内置 provider，`pi-ai/dist/providers/data/` 里没有它。它的上下文窗口只能由本机那个 `extension.ts` **手写声明** —— 而该网关的 `/v1/models` **只返回 id**，不含任何元数据（`/api/pricing` 401、`/api/models` 401、`/api/ratio_config` 403），所以**没有任何东西可以读**。扩展里写了什么，就是 pi 唯一会看到的东西。

实际写的是：`guessModel()` 里没有 `deepseek` 分支，于是 `deepseek-v4.1-flash`、`deepseek-v4-flash-0731` 全部落到 `128000` 默认值。

### 洞 2：`pi-router-catalog.json` 是一份**没有失效机制的缓存**

pi-smart-router 另存一份每个模型的 `contextWindow`：

```ts
// src/catalog/catalog.ts — merge()
contextWindow: existing?.contextWindow ?? info.contextWindow
```

`existing` **永远优先**。`merge()` 只被 `ensureSeed()` 调用，而 `ensureSeed()` 有 `entries.size === 0` 守卫 —— 也就是说：**这个文件一旦写出第一条，就再也不会从任何来源刷新**。写错的值是永久的。

同一件事，两个手抄副本，在两个互不通信的文件里。**这就是本次要修的缺陷。**

## 决策

### 1. 表放在仓库里，且每一行都要有出处

新增 `bridge/lib/pi-models.js`，导出 `FAMILY_META` —— 按 **model id 前缀**归类的家族表，每条规则必须带 `source`：

```js
{ id: 'deepseek-v4', re: /^deepseek-v4/, contextWindow: 1_000_000, maxTokens: 384_000,
  source: 'pi-ai/dist/providers/data/deepseek.json (…)' }
```

出处的**方向**是刻意的：不是「我们查了官网」，而是「**pi 自己发的那份数据**」。这样这张表才有一个可以被机器复验的锚点（见下一条）。

**表里没有任何网关主机名、端口、密钥。** 归类只依赖模型 id，而模型 id 是公开信息。一个公开仓库不该因为要修一个本机配置问题而带上私有端点 —— 本项目自己的脱敏扫描器（`scripts/scan-secrets.sh`）明令禁止携带任何主机名，不该为了图方便破自己的规矩。

### 2. 测试把表钉在 pi 的**真实文件**上，而不是钉在一份快照上

这是本 ADR 在工程上最有价值的一条。

「表 vs 别人发的数据」这类校验，最常见也最没用的写法是：把数字抄进测试 fixture，然后断言「表 == fixture」。那个测试永远绿，因为**它只是把同一份错误抄了两遍**。

所以测试读的是**机器上 pi 实际发布的那份 JSON**（路径由 `home` 推导，不硬编码绝对路径），逐条比对。pi 的数据变了而表没变，测试立刻红。

代价：**pi 没装时这个用例会 skip**。这是可接受的 —— skip 在测试输出里可见，而一份「永不失败」的测试比一条 skip 更危险。为了让这个 skip 不至于把整层检查一起带走，`doctor` 侧做了拆分（见第 4 条）。

### 3. 「多源不一致」时不猜，该条规则就断言 `null`

pi 自己发的 `anthropic.json` 说 `claude-opus-5` 输出上限 64,000；本机 `models-store.json` 说 128,000。

**不选边。** 该条规则的 `maxTokens` 写 `null` —— 语义是「**有分歧，本表对此不说话**」，比较时跳过，调用方回落到自己的默认值。

一条**只断言自己能证明的部分**的规则，比一条赌对了 50% 的规则有用。`maxTokens: null` 是显式的值，不是遗漏；`validate` 与测试都按「正整数或 `null`」校验，避免有人后来把它当漏填顺手补上一个数。

同理，`maxTokens` 的默认回落（`contextWindow >= 500_000 ? 65536 : 32768`）是**保守**选择，不是估计值。

### 4. 检查拆成两道，且**不互相绑架**

`doctor` 里两个问题必须分开：

| 问题 | 需要什么 | 缺了会怎样 |
|---|---|---|
| 本表是否还和 pi 发布的数据一致？ | pi 的 `data/*.json` | **无意义**（没有比对对象）→ 不检查 |
| 机器上某端的手抄值是否与本表/官方数据冲突？ | 本表（本表**就是**那个出处） | 仍可检查 |

所以早期版本里那句 `if (!official) return out;` 是错的：它让「读不到 pi-ai」顺带把**还能做的检查**一起静默关掉。修法是分别判空。

### 5. 只报告，**绝不重写**

这是本 ADR 与 ADR-004 最一致、也最需要守住的一条。

被检查的两个文件都不属于本项目：

* `~/.pi/agent/extensions/*.ts` 是**用户写的程序**；
* `pi-router-catalog.json` 是 pi-smart-router 的私有状态。

**把用户文件改成与一个公开仓库里的表一致，正是本项目在别处反复拒绝的那种"静默权威"。** 所以：`doctor` 报 `PI_CATALOG_CONTEXT_STALE`，给出条目的 `selector` / 期望值 / 实际值 / 出处，然后停手。用户自己决定。

配套地把两个文件登记进 `never_touch`（`pi-router-catalog.json`、`models-store.json`），让"不碰"成为清单里可读的事实，而不是代码里的默契。

### 6. 严重级别 `warn`

与 ADR-004 同一理由：**桥接器自己的产物没坏**。这两个文件不是桥接器生成的，`apply` 仍是对的，也不存在数据损坏风险。普通 `doctor` 退出 0；`doctor --strict` 算失败，供 CI / 巡检拉红线。

### 7. 认 id 的双拼写：pi 与网关对同一个模型用两个名字

pi 发布的文件里叫 `k3` / `k3-256k`；所有网关都叫 `kimi-k3` / `kimi-k3-256k`。**同一个模型，两个名字。**

只写一种拼写的规则，会**静默漏掉另一种**。所以 `k3` 系列的正则把 `kimi-` 做成可选，探针表两种拼写都探。

这条不是理论：本次真机普查就是靠它把 `shudie/kimi-k3` 的 `262144` 揪出来的 —— 它此前既不在家族表覆盖范围内，也不在探针里。

## 被否方案

### 方案 A：把 `extension.ts` 收进桥接器，做成模板下发

否决，两条：

1. 它含**私有网关域名与端点路径**，入库即违反本项目的脱敏铁律（自己的扫描器会拦）；
2. 它是一段**程序**（认证来源探测、动态发现、模型合并逻辑），不是一个配置值。把程序当模板管，等于把"清单是唯一结构知识来源"换成"仓库里存着任意可执行内容"。

### 方案 B：`doctor` 发现不一致就自动修

见决策 5。这是**越界**，不是"贴心"。用户手改过、或有本地特殊理由的值会被无声覆盖。

### 方案 C：校验后把 `pi-router-catalog.json` 从 `never_touch` 拿掉，纳入受管

否决。它是 pi-smart-router 的**运行时状态**（`learnScore` / `samples` / `lastSeen` 由插件自己写），不是从权威源派生的内容。纳入受管等于让"源"去拥有一个每秒都在变的文件。

### 方案 D：只修数字，不建表、不建检查

这是最初的做法，也是不够的做法：**修完就没人盯着了**。下一次网关加模型、pi 改数据、某人手改目录，同样的静默错误会原样复现。所以本次的产出重心从"改那 9 个数字"移到"建立一条会自己发现问题的链路"。

## 后果

### 正向

* 一次静默失效变成**可复验**的：家族表有出处，出处在机器上，测试对真实文件比对；
* 真机 `doctor` 立即报出了另一个此前无人知道的问题（`shudie/kimi-k3`），这一类是同一条链路自然会发现的；
* 表是**可加的**：新家族加一行（含 `source`），探针表加一行，测试自动开始盯；
* `maxTokens: null` 建立了一个先例：**宁可不断言，也不编一个数**；
* 拒绝了一个诱惑（方案 A/B/C），理由留在文档里。

### 负向 / 需接受

* 「家族」是个近似概念，正则边界需要靠**反例测试**维护（`glm-5.1` 是 200K 不是 1M、`claude-opus-4-5` 是 200K 不是 1M、`k3-256k` 比 `k3` 小）——本 ADR 把这几条写进测试，就是为了让边界是**被声明的**，而不是碰巧的；
* 规则只覆盖**能被证明**的家族。`qwen3.7-flash`、`Qwen3.8-27B`、`glm-5.2-fast` 在本机任何权威来源里都查不到，因此**不猜、不报**，只在人工报告里点名 —— 少报换正确；
* pi 未安装时，家族表一致性用例 skip；
* 表会**过期**。这正是测试存在的理由，但也要接受：一份依赖外部数据的断言，总有一天会被外部数据推翻（那时应该改表，而不是改断言）。

## 相关

* `bridge/lib/pi-models.js`（表 + 官方数据读取 + 两个检查）、`bridge/lib/doctor.js`（`checkPiContextWindows`）
* `bridge/test/pi-models.test.js`（表边界反例 / 与 pi 真实数据比对 / catalog 检查 / 端到端）
* `bridge/targets/pi.json`（`never_touch` 补 `pi-router-catalog.json`、`models-store.json`）
* `docs/ADR/004-declared-runtime-requirements.md`（同一个模式：**声明 → 探测 → 报告 → 不越界**）
* `docs/USAGE.md` §5.9（现象与说明）
