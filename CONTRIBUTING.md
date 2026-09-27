# 贡献指南

## 铁律：仓库零真实敏感值

本仓库是**公开**的。任何提交（代码、文档、模板、注释、测试 fixture、commit message、分支名）都不得包含下列任何一项：

| 禁止出现 | 正确写法 |
|---|---|
| 公网 / 内网 IP（含 `10.x`、`192.168.x`、`172.16-31.x`） | `<占位符>` 或从环境变量读 |
| 真实域名 / 子域名 | `<你的域名>` |
| 端口号（服务端口、SSH 端口、映射端口） | `<端口>` 或变量 |
| 用户名 / 家目录绝对路径（`home/<user>`、`Users/<user>`） | `os.homedir()` / `~` / `${HOME}` |
| API key / token / secret / 私钥 | `${VAR}`，真实值放仓库外的 `secrets.env` |
| 邮箱（含各类邮箱服务后缀） | `<你的邮箱>` |
| 主机名 / SSH 别名 / 隧道服务名 | `<主机别名>` |
| 云资源 ID / 桶名 / 集群名 | `<资源占位符>` |

### 提交前必做

```bash
bash scripts/scan-secrets.sh            # 扫描工作区 + 全部 git 历史
bash scripts/scan-secrets.sh --staged   # 只扫暂存区（pre-commit 用）
```

**命中即不得提交。** 若命中发生在**历史提交**里，只改最新 commit 不够，必须做全史清除（`git filter-repo`）后再强推——否则克隆者仍能拿到泄漏值。

## 开发约定

* **Node ≥ 20，零第三方依赖**：只允许标准库（`node:` 前缀导入）。新增依赖需先走 ADR 讨论。
* **`plan` 先于 `apply`**：任何会写盘的代码路径，必须能通过 `plan` 干跑预览。
* **写前必备份**：任何覆盖目标文件的代码必须先落备份。
* **fail-fast**：出错即中止，不得"跳过错误继续写后面的文件"。
* **不猜路径**：目标端路径只来自 `bridge/targets/*.json` 清单；代码中不得出现硬编码的端特定路径。
* **不静默降级**：格式转换遇到不支持的字段，要报告并跳过该字段（或报错），不得悄悄丢数据。

## 提交规范

```
<type>(<scope>): <简述>

<可选正文：为什么这么改、影响范围>
```

`type`：`feat` / `fix` / `docs` / `test` / `chore` / `refactor`
`scope`：`bridge` / `targets` / `mcp` / `docs` / `ci`

一次提交只做一件事。**禁止 `git add .`**——显式列出文件，避免把无关产物带进来。

## 测试

```bash
node --test              # 全部单测
node --check bridge/cli.js
bash scripts/scan-secrets.sh
```

CI 会跑同样三件事；本地先跑一遍再推。

## 新增一个目标端（agent）

1. 在 `bridge/targets/` 新增 `<name>.json`，显式声明受管路径；
2. 若涉及新的配置格式，新增对应写出器并补 fixture 往返测试；
3. 在 `docs/USAGE.md` 的端清单表中补一行；
4. 更新 `tasks/<当前变更>/TRACEABILITY.md` 的对应行。

不支持"临时猜路径"的兼容分支——清单缺失即视为不支持。
