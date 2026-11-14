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
bash scripts/scan-secrets.sh            # 只扫工作区
bash scripts/scan-secrets.sh --staged   # 只扫暂存区（pre-commit 用）
bash scripts/scan-secrets.sh --history  # 工作区 + 每个可达 commit（CI 跑的是这个）
```

**命中即不得提交。** 若命中发生在**历史提交**里，只改最新 commit 不够，必须做全史清除（`git filter-repo`）后再强推——否则克隆者仍能拿到泄漏值。

> 注意 `--history` 与不带参数是两回事：不带参数**不扫历史**。CI 用 `--history`，本地只跑不带参数版就等于没跑 CI 的那一步（2026-11-14 的 CI 红就是这么漏过去的）。

## 踩坑记录（写测试和 fixture 之前读一遍）

### 坑 1：「假家目录」也会被扫描器打死，一进历史就改不回来

2026-11-14 CI 红在 `sensitive content scan`，命中 `homepath`：

```
bridge/test/gate-dsh.test.js:83  Remove-Item -Recurse -Force "C:/Users/someone/../secrets"
bridge/test/gate-dsh.test.js:95  rm -rf /home/someone/../secrets
```

- **扫描器不区分真家目录和占位符**：`homepath` 正则匹配 `/home/<name>`、`/Users/<name>`、`<盘符>:\Users\` 这三种形状，`someone` 这种假名字照样命中。
- **`--history` 会扫每个可达 commit**，所以"改完最新提交再推"不会变绿：两个 commit 各留 2 条，共 4 条历史命中。
- **正确写法**：fixture 里不出现字面量路径，运行时拼出来。

```js
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const target = `${repo}/../secrets`;        // 运行时构造，扫描器看不到
```

### 坑 2：`path.join(dir, '..', 'x')` 会把 `..` 吃掉

`join()` 会规范化路径，`join('/a/b', '..', 'x')` 就是 `/a/x`，`..` 段消失了。而守卫读的是**原始操作数**里有 `..` 段（`unrecoverableTarget` 的第一行），所以拼出来的命令"看着像穿越"却不触发。要保留 `..` 必须字符串拼接：

```js
const target = `${dir}/../secrets`;   // ✅ 保留 ..
const target = join(dir, '..', 'secrets');   // ❌ 归一化，守卫看不到
```

### 坑 3：拿 `os.tmpdir()` 造 guardrail 用例，永远是 allow

分类器把 **temp / build / dist / node_modules** 当"构建产物"豁免，`..` 也在豁免生效之后才判定。`os.tmpdir()` 在 `Temp/` 下，所以 `rm -rf "<tmp>/../secrets"` 拿到的是 `null`（不是 destructive），用例永远不红。

要测 guardrail，基准目录必须是**非临时目录**（仓库根即可）。

### 坑 4：Windows 上 `bash` 可能是 WSL 的 bash

`bash scripts/scan-secrets.sh` 在 Windows 上如果解析到 WSL 的 bash，会报一堆：

```
scripts/scan-secrets.sh: line 17: $'\r': command not found
wsl: Failed to translate 'F:\software\Git\cmd'
```

CRLF + 路径翻译双重问题。用 Git Bash 的绝对路径跑：

```powershell
& 'C:\Program Files\Git\bin\bash.exe' scripts/scan-secrets.sh --history
```

### 坑 5：历史已经推上去、又确实是占位符时，走白名单而不是强推

历史上已经公开的**可证明公开值**（如文档占位符 `someone`），按 `scan-secrets.sh` 的既定出口在 `ALLOW_PATTERNS` 加**窄到字面量**的例外，并在注释里写清为什么安全；**不要**为了方便去重写已发布历史。反过来，真值一旦进历史就必须全史清除 + 强推（见上）。

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

CI（`.github/workflows/ci.yml`，3 OS × Node 20/22/24）跑的是这三步，本地照跑：

```bash
# 1. 语法检查：bridge 下每个 .js
for f in $(find bridge -name '*.js'); do node --check "$f" || exit 1; done

# 2. 单测
node --test

# 3. 敏感内容扫描（工作区 + 全部历史；Windows 用 Git Bash 绝对路径）
bash scripts/scan-secrets.sh --history
```

三步任何一步红都不要推——CI 会替你红在三个平台上。

## 新增一个目标端（agent）

1. 在 `bridge/targets/` 新增 `<name>.json`，显式声明受管路径；
2. 若涉及新的配置格式，新增对应写出器并补 fixture 往返测试；
3. 在 `docs/USAGE.md` 的端清单表中补一行；
4. 更新 `tasks/<当前变更>/TRACEABILITY.md` 的对应行。

不支持"临时猜路径"的兼容分支——清单缺失即视为不支持。
