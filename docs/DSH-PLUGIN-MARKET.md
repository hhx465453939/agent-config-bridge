# dsh 插件市场与推荐插件

dsh（DeepSeek Harness）**没有官方插件市场**。生态里能逛的地方分成三类：社区目录站（网页）、GitHub 标签/清单（源头）、以及装进 dsh 里用的应用内市场。本页把三类各列几条，并说明本仓库怎么把入口做进 dsh 侧栏。

所有地址在 2026-11-14 实测可达（HTTP 200）。收录数字是各家站点自报，量级会变。

## 一、社区目录站（浏览器里逛）

| 站点 | 特点 |
|---|---|
| https://dshplugin.io | 3,700+ 条，分类浏览，每条带现成的 `dsh plugin add` 命令 |
| https://dshplugin.dev | 1,100+ 条，来源是官方仓库 + GitHub topic，每天刷新 |
| https://deepseek1024.com | 站点自报 11,000+，有排行榜和免费搜索 API |
| https://mydsh.dev/plugins | 每个插件有 AI 中文总结，支持一句话描述需求搜索 |
| https://dsh.deepseek404.com | 中文站，标注每个插件的安装参考和是否已验证 |
| https://dsh-plugin.org | 中文/英文混排，分类 + 安装命令 |
| https://dshfind.com | 编辑器精选 Top Picks，另有学习社区 |
| https://deepseekdocs.com/ecosystem | 按 star 排序的全量生态页 |

## 二、GitHub 源头

| 入口 | 特点 |
|---|---|
| https://github.com/topics/dsh-plugin | 官方 README 让作者打的标签，新插件最先出现在这里 |
| https://github.com/topics/deepseek-harness-plugin | 第二个活跃标签，覆盖没打 dsh-plugin 的仓库 |
| https://github.com/awesome-dsh-plugin/awesome-dsh-plugin | 社区最大清单（约 1.5k 条），一个插件一个 YAML，定时扫失效链接 |
| https://github.com/imsai-sh/awesome-deepseek-harness-plugins | 自称 11,000+，带格式校验和免费搜索 API |
| https://github.com/0xsline/awesome-deepseek-harness | 按用途分类的生态总览（基础设施 / UI / 记忆 / 多 agent） |
| https://github.com/dsh-plugins | 组织页，含 `dsh-plugin-market` 等结构化市场仓库 |

## 三、装进 dsh 里用的市场

| 仓库 | 特点 |
|---|---|
| https://github.com/dsh-market/dsh-market | 装好后插件页出现「Plugin Market」标签页，可搜索 / 安装 / 更新 / 卸载 |
| https://github.com/bradeGithub/DSH-Plugins-Marketplace | 一键浏览 / 安装 / 更新整个 `dsh-plugin` topic |

## 四、推荐插件（按用途，2026-11-14 仓库均可达）

只列「补的是 dsh 本体缺的那块」的，不列皮肤和整活类。装之前看 README、最近提交和 license。

| 用途 | 仓库 | 一句话 |
|---|---|---|
| 推理强度（自定义模型） | https://github.com/hytime/dsh-thinking-effort | 给手写声明的 `llm-pi-ai` 模型补 `reasoningEfforts`，附设置页与兼容字段编辑 |
| 推理强度（界面滑块） | https://github.com/HanaAyane/dsh-reasoning-effort | 在模型选择器里加思考强度滑块，跟随 `/model` 的档位 |
| 推理强度（自动调度） | https://github.com/lion231226/dsh-auto-reasoning-effort | 按消息难度自动选 low/high/max，手动选档时让路 |
| 上下文洞察 | https://github.com/bowenliang123/dsh-context | 看上下文 token 被谁吃了 |
| 多 agent 协作 | https://github.com/NanmiCoder/dsh-agent-teams | Agent Teams 多智能体协作 |
| 侧栏工作台 | https://github.com/omdsh-dev/DSH-better-sidebar | 开放侧栏底座：文件 / 终端 / 侧边对话 / Git / 子代理页面 |
| 终端界面 | https://github.com/ccch1mneyyy/dsh-TUI | Claude Code 风格的 TUI（状态、上下文进度、TPS） |
| Web 聚合 | https://github.com/zhu1090093659/dsh-web | Web 插件聚合生态包 |

## 五、本仓库的侧栏入口模块

源码在 [`dsh/market-links/`](../dsh/market-links/)，装好后 dsh 左侧边栏多一行「插件市场」：点开是上面三类目录的分组清单，点任意一条用系统浏览器打开。

### 看状态

```bash
node scripts/install-dsh.js --only market
```

输出三件事：源码是否完整、每个 profile 是否已经装上、以及装它要跑的命令。

### 为什么这个模块不往 `~/.dsh/plugins/` 拷文件

门控和斜杠命令是**拷贝 + 挂载一行 patch**，因为它们的全部行为都在 Host 半边。带浏览器半边的插件不一样：dsh 只从 **profile 的包**构建 Client 模块图，用路径挂载的行只有 Host 半边生效——侧栏那一行和面板会被静默丢掉。唯一能工作的装法是把包加进 profile 的依赖图，而 `.dsh/profiles` 是本仓库清单里的 `never_touch`（那个文件的另一个写入者是 dsh 图形界面）。

所以这个模块只做校验、状态报告和打印命令，**不假装自己写过什么**。

### 装 / 卸载

桌面端（profile 由应用独占，CLI 改不了）：

1. 侧栏「插件」→ **添加插件** → 填 `dsh/market-links/` 的绝对路径；
2. 刷新页面，侧栏出现「插件市场」。

Web profile（有 `dsh` CLI 时）：

```bash
dsh plugin --profile web add "<本仓库绝对路径>/dsh/market-links"
dsh web
```

卸载：应用内插件页停用/卸载，或 `dsh plugin --profile web remove dsh-market-links`。

### 改清单

市场与推荐列表是数据，不是逻辑：改 [`dsh/market-links/client.js`](../dsh/market-links/client.js) 里的 `GROUPS`，新增一条 = 加一个 `{ name, url, note }`。本页的表格同源，改完一起改。

### 边界

- 只是导航：不抓取、不校验、不代装任何第三方插件；「收录」不等于「可安装」。
- 不读会话数据、不注册工具、不向模型发送任何内容（Host 半边是空函数）。
- 目录站会换域名、会挂；`bridge/test/market-links.test.js` 只保证清单结构完整（https、唯一、可点），**不联网验证存活**——CI 不该依赖第三方站点。