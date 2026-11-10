# 开发与发版规范

- **特性开发**：在独立 worktree/分支开发，测完合入 `master`。**特性分支严禁私自 bump 版本或打 tag**。
- **发版只在 Master**：用户明确要求发版时，在最新 `master` 上操作。
  - 版本号唯一位置：`packages/desktop/package.json`
  - `CHANGELOG.md` 必须包含中英双语（CI 强校验）
  - 打 `v<version>` tag 推送触发 CI，GitHub Release 资产生成完毕才算发布完成。

## 开发参考

- 功能设计与开发优先参考 [Alma](https://alma.now/) 的产品行为、Agent 能力、记忆与会话机制及界面交互。优先阅读用户指定的 Alma 架构资料，必要时查阅官方文档、下载应用或检查可获得的实现。
- 结合 SuperIU 的现有架构和当前需求适配，说明借鉴点与必要差异。区分资料描述、实际验证与设计推断，未验证的机制不得当作已确认事实，也不直接照搬参数、路径或内部结构。
