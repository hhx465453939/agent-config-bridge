# ADR-004 — 用「声明式运行时依赖 + doctor 探测」堵住静默失效

```yaml
adr: 004
change_id: CHG-001
status: proposed
date: 2026-09-29
deciders: [user]
```

## 背景

本项目的核心承诺是**清单是唯一的结构知识来源**（`README.md` §"会桥接什么"、`docs/USAGE.md` §6）。这条承诺换来的是可审计：所有受管路径都能在 `bridge/targets/*.json` 里读到，代码里没有"猜路径"的逻辑。

但它有一个**结构性盲区**，而且是本项目真正的一次事故：

pi 本体**没有内建 MCP 支持**。MCP 能进 pi 只有一条路 ——

```
~/.pi/agent/mcp-adapter.json   ← 桥接器生成、受管、被快照、被 diff
        ↑ 读它的是
pi-mcp-adapter 这个 npm 包      ← 记在 ~/.pi/agent/settings.json 的 packages 里
        ↑ 而 packages 在
~/.pi/agent/settings.json      ← 本项目的 never_touch（永不接管）
```

于是出现一个**没有任何一方报告错误**的状态：

* `apply` 每次成功，`diff` 每次为 0，`doctor` 全绿；
* 生成的 `mcp-adapter.json` 内容正确、权限 600、快照完整；
* 但机器上**没有任何程序会去读它**；
* 后果是 MCP server、`codebase-memory` 的直连工具、以及依赖这些工具名的**硬闸门**（ADR-003）**一起静默消失**。

触发条件很平常：pi 重装、npm 缓存被清、换台机器只跑了 `adopt`/`apply`。真实后果是本机 pi 的 MCP 与硬闸门同时"死"了一段时间，直到人工排查才发现根因是缺一个包。

**这里没有 bug。** 生成正确；不装包也是对的（`settings.json` 是用户的）。真问题在于：**目标端"需要一个外部程序才能让产物生效"这件事，没有被记录下来，因此没有任何检查能发现它不成立。**

## 决策

### 1. 需求写在清单里，而不是写在代码里

`bridge/targets/<agent>.json` 的受管条目可增加 `requires` 数组：

```json
{
  "kind": "mcp",
  "mode": "mcp-json",
  "to": ".pi/agent/mcp-adapter.json",
  "requires": [
    {
      "id": "pi-mcp-adapter",
      "probe": ".pi/agent/npm/node_modules/pi-mcp-adapter/package.json",
      "unless": ".pi/agent/extensions/pi-mcp-adapter",
      "install": "pi install npm:pi-mcp-adapter",
      "why": "pi has no built-in MCP support, so this package is the only thing that reads the generated config; ..."
    }
  ]
}
```

* `probe` —— 指向"这个东西存在"的证据文件，**相对 `home`**；一段里含 `node_modules/` 时还会额外尝试全局前缀与 cwd（见下）；
* `unless` —— 可接受的**备选位置**（"也可以装在这儿"），避免把换了装法的用户误报成缺失；
* `install` —— 修复命令，原样进 `doctor` 的提示行；**不执行**；
* `why` —— 缺失后的真实后果，写在告警正文里。

`requires` 是**逐受管条目的**，因为它描述的是"这份产物需要什么"。放在条目上也让"文件名是 mcp-json 时"这类特例判定彻底不需要。

### 2. 探测只在 `doctor` 里做，绝不进 planner

这是本次最关键的一条边界。`plan` / `apply` / `diff` 必须是**源 + 目标的确定性纯函数**：

* `plan` 一旦开始探测环境，"同一份源在两个机器上产生了不同计划"就成为常态，`apply` 不再可复现；
* 仓库里有一批**金标准快照测试**（`apply`/`diff`/`plan` 的期望输出）。把环境注入 planner 会让这些测试变成掷硬币。

所以："某个包装没装"是**环境事实**，它属于自检命令（`doctor`），不属于计划命令。这也让本次改动**不触碰 planner 一行代码** —— 现有快照测试零改动即通过。

### 3. 严重级别是 `warn`，不是 `error`

理由：**桥接器自己的产物没有坏**。`apply` 仍然是正确动作，也不存在"数据可能损坏"的风险。它与既有的 `SOURCE_MCP`、`MCP_UNSUPPORTED`、`TARGET_UNVERIFIED` 同类 —— 一类"外部世界不完全如你所想"的提醒。

* 普通 `doctor` 仍退出 0（不打断日常流程）；
* `doctor --strict` 会把它算作失败（`finish` 里既有语义），CI / 巡检想当红线随时可以拉。

### 4. 只在"已桥接 **且** 该产物确实存在"时报

避免两种噪音：

* 目标端还是 `native` —— 桥接器什么都没生成，没有东西被孤立；
* 产物还没生成（比如首次 `plan` 之前）—— 同上。

判据因此精确为："**一份由本工具生成的文件在盘上，但读它的程序不在了**"。

### 5. 探针是通用路径判断，库里没有 pi 专属代码

`probe` 就是一次「这个相对路径存在吗」。额外尝试全局 npm 前缀（`<home>/.npm-global/lib/node_modules/...`）与 cwd 的 `node_modules/`，是因为**同一个包常有好几种装法**，而多试几个位置的成本只是"少一次误报"。探测是只读的，不涉及 `never_touch`，因此不构成越界。

任何端都可以用同一机制声明任何伴随程序（kimi、dsh、未来的端），与"清单是唯一结构知识来源"一致。

## 被否方案

### 方案 A：让 `apply` 自动装包

* 做法：检测到 `requires` 未满足就执行 `install`。
* 否决原因有两条，任一条都够了：
  1. **写 `never_touch`**：`pi install` 会写 `~/.pi/agent/settings.json` 的 `packages`，而该文件是本项目明确承诺"永不接管"的（用户在里头管理自己的包选择）。为了修一个越界造成的静默失效，去越界一次，是错的；
  2. **副作用不可预期**：`apply` 的本分是"把配置同步成源的样子"。顺手装/升/删一个 npm 包（可能装在全局、可能触发网络）属于行为惊讶，而且失败时 `apply` 的语义就不再单一。

### 方案 B：在 `targets/pi.json` 里加一个只给 `doctor` 读的自定义字段，但不进 `validate`

* 否决原因：`manifest.validate` 会**静默丢弃未知字段**（只返回受控形状），所以任何不显式校验的字段都是死数据 —— 写了不生效，比不写更糟（会让人以为加上了）。因此本次**同时**补上 `validateRequires`，并按既有风格对未知字段**显式报错**而不是忽略。

### 方案 C：把 `settings.json` 纳入 `managed`

* 否决原因：直接违背 D 系列决策与 README 的边界表 —— 那是用户自己的包选择、模型选择、主题。桥接器接管它，等于替用户做包管理决定。

### 方案 D：在 `status` 里报

* 否决原因：`status` 的语义是"状态机（native / bridged / revoked）+ 漂移数"，它回答"我该不该 adopt/apply"。环境探测属于 `doctor`（"现在有哪里不对"），混进去会让两个命令的语义互相稀释。

## 后果

### 正向

* **一次静默失效变成每次跑 `doctor` 都会重刷的提示**，且带可直接粘的修复命令；
* planner 未改动，`apply` 的可复现性与金标准测试不受影响；
* 机制是通用的：新端、新伴随程序只需在清单里加一条；
* 拒绝了一个"顺手越界"的诱惑（方案 A），并把拒绝理由留在文档里。

### 负向 / 需接受

* 清单多了一个需要理解的概念（`probe` / `unless` / `install` / `why`）；
* 探测位置是启发式（多试几个前缀），可能**少报**（包装在某个更奇怪的地方）—— 但这条告警的性质是"提醒"，不是"安全门"，少报的代价低于误报；
* `warn` 级别意味着**不主动打断**用户：不看 `doctor` 就仍然看不见。这是刻意的取舍（与既有 warn 语义一致），想当红线请用 `--strict`；
* 沙箱需要一份 adapter 桩（`bridge/test/sandbox.js`），否则所有 `doctor` 用例都会挂一条假告警 —— 假告警比没有用例更糟，因为它会训练人忽略这一行。

## 替代思路记录

最初考虑把 `requires` 做成"逐规则的 `requires_package: string`"（更短）。改为数组 + 对象，是为了让**备选位置**（`unless`）、**修复命令**（`install`）、**后果说明**（`why`）都有地方放 —— 一条只说"缺了"的告警，用户还得自己去查怎么装，价值会减半。

## 相关

* `bridge/targets/pi.json`（唯一使用方）、`bridge/lib/manifest.js`（`validateRequires`）、`bridge/lib/doctor.js`（`findRequirement` / `REQUIREMENT_MISSING`）
* `bridge/test/engine.test.js`（缺失 / 未桥接静默 / 备选位置 / 校验失败 四类用例）
* `docs/USAGE.md` §5.8（现象与说明）、§8（故障排查）
* `docs/ADR/003-hard-gates.md`（闸门依赖这些工具的**名字**，所以本 ADR 描述的失效会连带闸门一起失效）
