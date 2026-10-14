# 开发与发版规范

- **特性开发**：在独立 worktree/分支开发，测完合入 `master`。**特性分支严禁私自 bump 版本或打 tag**。
- **发版只在 Master**：用户明确要求发版时，在最新 `master` 上操作。
  - 版本号唯一位置：`packages/desktop/package.json`
  - `CHANGELOG.md` 必须包含中英双语（CI 强校验）
  - 打 `v<version>` tag 推送触发 CI，GitHub Release 资产生成完毕才算发布完成。
