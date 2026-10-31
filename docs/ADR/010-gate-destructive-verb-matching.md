# ADR-010 · 破坏性动词的匹配粒度：前缀 vs 整体相等

- 状态：accepted
- 日期：2026-10-31
- 相关：ADR-003（硬门控）、ADR-008（误伤收敛与失败关闭）、CHG-20261031-gate-format-false-positive

## 背景

门控的 `no-destructive-bash` 用一张动词表判断「主机级破坏」：

```js
if (/^(?:mkfs|fdisk|parted|diskpart|format)/.test(verb) || ['shutdown', 'reboot', 'poweroff', 'halt'].includes(verb)) {
  return finding(`${verb} is a host-level destructive command`);
}
```

其中 `mkfs` / `diskpart` 用前缀是**正确**的：`mkfs.ext4`、`mkfs.xfs`、`diskpart.exe` 都指向同一个破坏性程序。`format` 混进这张表则是错的：它在 bash/CMD 里是裸动词，在 PowerShell 里却是**只读输出格式化指令族的前缀**。

实测后果（本机，2026-10-31）：`Get-Acl . | Format-Table Name,Rights`、`Format-List`、`Format-Wide`、`Format-Custom`、`Format-Hex`、连 `formatter --help` 全部被判成 host-level destructive。因为判据吃的是整条命令文本，连「写一条探针来证明这是误伤」都被拦下。

## 决策

1. `format` 从前缀族移出，改为**整体相等**（允许 `.com` / `.exe` 后缀）。
2. `Format-Volume` 单独点名——它是 `Format-*` 族里真正摧毁卷的那一个。
3. `mkfs` 保留后缀族匹配（`mkfs(?:\.[a-z0-9]+)?`），`fdisk` / `parted` / `diskpart(?:\.exe)?` 用整体相等。

```js
const HOST_DESTRUCTIVE_VERB =
  /^(?:mkfs(?:\.[a-z0-9]+)?|fdisk|parted|diskpart(?:\.exe)?|format(?:\.(?:com|exe))?|format-volume)$/;
```

`verb` 由 `commandBase` 产出（剥目录 + 小写化），所以 `C:\Windows\System32\` 下的 `format`（带 `.com` 后缀）归一成同名动词后仍然命中。

## 备选方案与否决理由

| 方案 | 否决理由 |
|---|---|
| 机器本地 `destructive_allow_patterns: ["\\bFormat-(Table|...)\\b"]` | allow 是**整条命令**的前置放行：一条命令里同时出现 `Format-Table` 与 `format D: /q` 时，真格式化会被一起放过。把一个误伤换成一条永久配置债，还削弱了整条 shell 通道。 |
| 引入 PowerShell AST / 词法器 | 门控零第三方依赖且不执行命令；收益是「多识别几种破坏形态」，成本是一个解析器加它的维护面。 |
| 直接把 `format` 从破坏性表里去掉 | `format D: /q` 会漏放——安全网破洞比误伤更贵。 |

## 取舍

- **只读族默认放行，破坏性的显式点名**：将来 PowerShell 新增破坏性 `Format-*` cmdlet，需要显式加名。方向是有意的——误伤会逼用户关检查（见 ADR-008），漏放只会漏掉一个新 cmdlet，且它仍会被 `no-write-outside` / 破坏性命令的其它分支部分覆盖。
- **不追求语义级判定**：`format` 藏在字符串字面量里仍可能误判；反过来，`echo format D:` 这种纯文本也不会被执行。这是词汇表的固有边界，接受。
- **同一张表继续混放 bash 与 PowerShell 动词**：不为两端各建一张表；代价是每加一个动词都要想清它是「裸动词」还是「族前缀」。

## 后果

- Windows 上检查类管道不再被打回；agent 可用 `Format-Table` 正常排布输出。
- `formatter` 这类以 `format` 开头的普通词不再误判。
- 新增回归用例守住两侧（11 个应拦形态，含 `cmd /c` 嵌套），下次有人再动这张表会先撞红。
- 已知残留：`Format-*` 之外的其他只读 cmdlet 若恰好与破坏性动词同前缀，仍会误伤——待出现具体案例再收（不做投机性收紧）。
