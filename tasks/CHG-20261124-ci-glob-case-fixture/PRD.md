---
change_id: CHG-20261124-ci-glob-case-fixture
version: 1
status: approved
created: 2026-11-24
owner: Owner
---

# PRD-20261124 · CI 持续红（macOS/Linux）

## 用户问题

`main` 分支的 CI 从 2026-11-16 起一直失败，每次 push 都是红的。
失败点固定是一个测试用例，与业务代码无关，因此没有人立刻处理，但它掩盖了
后续所有真正的回归信号——红着红的 CI 等于没有 CI。

## 期望

- 三平台 CI 恢复绿。
- 保持测试原意（glob 与路径文本匹配大小写不敏感），不删测试、不跳过平台。
- 不为了让它绿而放松门控。

## 验收

见 `SPEC.md` 的 AC-1 ~ AC-4。
