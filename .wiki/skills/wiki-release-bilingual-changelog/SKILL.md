---
name: wiki-release-bilingual-changelog
description: |
  Release 发布必须包含中英双语 changelog 的项目约定与机制
  - CHANGELOG.md 每个版本小节必须同时含 `### 中文` 与 `### English`
  - scripts/extract-changelog.mjs 提取小节为 GitHub Release 正文，缺失即发布失败
  - release.yml 标签发布用 --version，滚动 latest 渠道用 --unreleased
  - `pnpm test` 通过 --check 校验 changelog 结构
---

# Release 必须包含中英双语 Changelog

## 快速参考

| 场景 | 正确做法 | 违规后果 |
|---|---|---|
| 发新版本 | 先在 CHANGELOG.md 补 `## v.x.y.z (日期)` 小节，含 `### 中文` + `### English`，再打 tag | release job 提取小节失败，发布中断 |
| 合并到 master | 把用户可感知变更同步写入 `## Unreleased` 小节（双语） | 滚动 latest 渠道正文缺内容 |
| 校验 | `node scripts/extract-changelog.mjs --check`（已并入 `pnpm test`） | CI 挂 |
| 版本发布正文 | 标签用 `--version=x.y.z`；master 推送用 `--unreleased` | — |

## 机制

- `.github/workflows/release.yml` 的 `release` job 会 checkout 仓库，运行
  `scripts/extract-changelog.mjs` 提取对应小节写入 `changelog-body.md`，
  经 `body_path` 交给 softprops/action-gh-release；`generate_release_notes: true`
  仍开启，自动 PR 列表追加在双语正文之后。
- 小节标题格式：`## v0.2.7 (2026-10-05)` 或 `## Unreleased | 未发布`；
  正文必须同时包含 `### 中文` 与 `### English` 两个子标题，缺一即 fail。
- 新知识点：项目为中文用户为主、双语意识强（已有 check-cli-i18n / check-ui-i18n /
  check-dict-parity），changelog 双语是该约定的自然延伸。
