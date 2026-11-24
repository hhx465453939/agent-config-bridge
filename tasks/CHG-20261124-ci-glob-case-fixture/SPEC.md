---
change_id: CHG-20261124-ci-glob-case-fixture
version: 1
status: approved
prd_ref: PRD.md
created: 2026-11-24
owner: Owner
---

# SPEC-20261124 · 修复 CI 在 macOS/Linux 上的 glob 大小写用例失败

## 1. 问题

`ai-spec: glob 大小写不敏感` 这条测试自 CHG-20261116 起在 **macOS 与 Linux** 上失败
（Windows 通过），导致 CI 从 2026-11-16 起持续红：

```
AssertionError: 路径大小写混写也应匹配
  actual: true      (被拦了)
  expected: false   (应当放行)
```

## 2. 根因（不是实现 bug）

- 实现侧 `isChgContract` 已经两侧小写化，glob 匹配本身与大小写无关。
- 但测试把**目录名**也换了大小写：fixture 的契约目录是 `tasks/CHG-001-Foo`，
  `recordDocRead` 却用了 `tasks/Chg-001-Foo`。`contractFs` 是精确字符串集合，
  POSIX/macOS 上这是**另一个目录**，其下的 PRD / TRACEABILITY 并不存在，
  于是契约不成立、门控照拦。
- Windows 上 `normalizePath` 会把路径整体小写化，把这个差异抹平了，所以 CI 的
  windows 作业一直是绿的，掩盖了错误的平台假设。

## 3. 目标（可判定终态）

1. fixture 的契约目录大小写与真实目录（`CHG_DIR`）一致，只让文件名大小写变化；
2. 该测试在 ubuntu / macos / windows 三平台 × Node 20/22/24 全部通过；
3. 不放松任何真实拦截逻辑（`isChgContract` / `chgDirOf` 不改）。

## 4. 验收判据（Acceptance Criteria）

- **AC-1**：`node --test bridge/test/gate-policy.test.js` 中
  `ai-spec: glob 大小写不敏感` 通过。
- **AC-2**：该用例的目录部分由 `CHG_DIR` 派生，不再出现字面量 `Chg-001-Foo` /
  `TASKS/CHG-001-FOO`。
- **AC-3**：`node --test` 全量通过；`node --check` 全部通过；
  `scripts/scan-secrets.sh --history` 零命中。
- **AC-4**：CI 在三个平台全部转绿。

## 5. 不做的事

- 不把门控改成「文件系统路径也大小写不敏感」。POSIX 文件系统大小写敏感，
  小写化真实路径会读不到文件，属于引入新 bug 而非修 bug。
