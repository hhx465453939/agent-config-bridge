# dsh-market-links

DSH（DeepSeek Harness）左侧边栏加一个「插件市场」入口：点开是一张分组的市场/目录清单，点任意一条就在**系统浏览器**里打开对应站点。找到想要的插件后，把包名或 `github:作者/仓库` 发回会话，由 agent 用 `plugin_manager` 装、停用或卸载。

## 它做了什么

- 侧栏一行 `插件市场`（图标 + 文字；收起成 56px 轨道时显示图标 + tooltip）。
- 点击后打开同名的 `main` 面板：三组链接（聚合目录站 / GitHub 源头 / 应用内市场），每条带一句用途说明和原始地址。
- 面板底部给出安装命令模板和三种安装路径（桌面端插件页、CLI、会话里让 agent 装）。

为什么是「面板」而不是「按钮下面展开子菜单」：DSH 侧栏只公开两类插槽——`sidebar.panellist`（一行一个功能入口）和 `main`（按该行 id 取用的面板）。它没有「在某一行下面再塞几行」的插槽，所以面板是这套壳子支持的形状。

## 收录的站点（2026-11-14 全部实测可达）

| 分组 | 站点 | 一句话 |
|---|---|---|
| 聚合目录 | https://dshplugin.io | 3,700+ 条，分类 + 现成安装命令 |
| 聚合目录 | https://dshplugin.dev | 1,100+ 条，官方仓库 + GitHub topic，日更 |
| 聚合目录 | https://deepseek1024.com | 站点自报 11,000+，排行榜 + 免费 API |
| 聚合目录 | https://mydsh.dev/plugins | AI 中文总结，支持一句话描述需求搜索 |
| 聚合目录 | https://dsh.deepseek404.com | 中文站，标注安装参考与验证状态 |
| 聚合目录 | https://dsh-plugin.org | 分类 + 安装命令 |
| 聚合目录 | https://dshfind.com | 编辑器精选 + 学习社区 |
| 聚合目录 | https://deepseekdocs.com/ecosystem | 按 star 排序的全量生态页 |
| GitHub 源头 | https://github.com/topics/dsh-plugin | 官方 README 指定的作者标签 |
| GitHub 源头 | https://github.com/topics/deepseek-harness-plugin | 第二个活跃标签 |
| GitHub 源头 | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin | 社区最大清单（约 1.5k 条） |
| GitHub 源头 | https://github.com/imsai-sh/awesome-deepseek-harness-plugins | 11,000+，带校验 |
| GitHub 源头 | https://github.com/0xsline/awesome-deepseek-harness | 按用途分类的生态总览 |
| GitHub 源头 | https://github.com/dsh-plugins | 组织，含 dsh-plugin-market |
| 应用内市场 | https://github.com/dsh-market/dsh-market | 插件页出现「Plugin Market」标签，可搜索/安装/更新 |
| 应用内市场 | https://github.com/bradeGithub/DSH-Plugins-Marketplace | 一键浏览/安装/更新整个 topic |

改列表只改 `client.js` 里的 `GROUPS`；新增一条 = 加一个 `{ name, url, note }`。`url` 必须是 `http(s)://`，点击交给 Electron 的 `setWindowOpenHandler` → `shell.openExternal`，所以不会在 DSH 里开窗。

## 安装

### 桌面端（当前应用）

侧栏「插件」页 → **添加插件** → 填这个目录的绝对路径或打出来的 tgz。桌面 profile 由 Electron 独占，`dsh plugin --profile desktop …` 会被拒绝，这是设计而不是故障。

装完刷新页面（或重启应用）即可在侧栏看到入口。

### 命令行（web profile）

```bash
dsh plugin --profile web add <本目录绝对路径 或 tgz 路径>
dsh web
```

## 卸载

应用内插件页停用/卸载即可；命令行用 `dsh plugin --profile web remove dsh-market-links`。

## 边界

- 只是导航：不抓取、不校验、不代装任何第三方插件。目录站的「收录」不等于「可安装」，装之前看仓库 README 与最近提交。
- 不读会话数据、不注册工具、不向模型发送任何内容（`GET /index.js` 是空的 Host 半边）。
- 站点的收录数字是各家自报，会变；本文件记录的只是实测当天的量级。
