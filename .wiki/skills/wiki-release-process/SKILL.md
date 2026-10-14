---
name: wiki-release-process
description: |
  SuperIU 发版流程与分支基线纪律
  - 核心主线：master 为唯一发布基线，严禁为日常 patch 发版创建一次性 release/* 分支或套娃 release worktree
  - 特性开发：日常在短命特性 worktree 中进行，发布前合入 master，tag v* 锁定版本
  - 版本号 bump 唯一位置 packages/desktop/package.json，必须包含中英双语 CHANGELOG
  - 闭环销毁：特性发布后立即销毁对应的 worktree 与特性分支，严禁堆积僵尸工作区
  - 终态验收：CI run completed + GitHub Release 资产齐备才算发版完成
---

# SuperIU 发版流程与基线纪律

## 0. 铁律：先核对基线，再动手

**历史惨痛教训**：改了 A，却没发现 `master` 上早已有 A 的更新版本 / 相反决策 / 相关修复。
根因不是记性差，而是**长期在某个落后的工作树中直接发版**（例如停在 `Kayphoon/torpedo`，落后 `master` 十余个提交）。

发版或任何跨文件改动**之前**必须先做：

```bash
git fetch origin --tags
git rev-list --left-right --count origin/master...HEAD   # 左=master 独有（你看不见的），右=本分支独有
git log --oneline HEAD..origin/master                    # 逐条看 master 上有什么
```

* **「左」不为 0 就是危险信号**：说明 `origin/master` 上有对当前工作树不可见的工作。此时：
  * 先读这些提交，判断是否与本次改动冲突/重复/已被修复；
  * **发版必须以最新的 `origin/master` 为最终基线**，严禁在落后分支上直接打 tag。
* 判断某个"约定/修复是否已存在"时，**必须查 `origin/master`**，不是当前工作树：
  ```bash
  git show origin/master:<path> | grep -n <关键词>
  git log --oneline -S '<关键词>' origin/master -- <path>
  ```
  用落后的工作树 grep 会给出**假阴性**（"没有记录"实际上是"我这份副本太旧"）。

## 1. 版本号与发布触发

* **唯一位置**：`packages/desktop/package.json` 的 `version`。bundle 名 `SuperIU-<version>-mac-<arch>.zip|dmg`
  与自动更新客户端的比较都读它（`bundle-mac.ts` 从 package.json 读 version）。
* 触发方式（`.github/workflows/release.yml`）：
  * push tag `v*` → 正式 Release（`prerelease: false`），运行 `release` CI job；
  * push `master` → 滚动 `latest`（`prerelease: true`），清空旧资产。
* **已安装客户端只在版本号变化时才看到更新**——任何要交付的修复都必须 bump，不能复用已发布的版本号。
  bump 提交格式遵循惯例：`chore(release): bump to <version> with bilingual changelog`。
* `CHANGELOG.md` 必须同时包含 `### 中文` 与 `### English`（见 `wiki-release-bilingual-changelog`）。

## 2. 架构模式：短命特性 Worktree + Master 主干打 Tag

> **⚠️ 历史反模式废止声明**：
> 过去为了防污染，曾要求“每次发版另建 `release/<ver>` 分支并开专属 worktree cherry-pick”。
> 该做法已被**彻底废除**。它导致了 40+ 一次性僵尸分支与后台 worktree 堆积。
> **Tag 本身就是版本快照，日常 Patch 发布严禁新建 `release/*` 分支！**

标准工作流分为 4 步：

```text
[特性 Worktree 开发] ──> [本地验证通过 & Bump] ──> [合入 origin/master] ──> [打 Tag v* 推送] ──> [销毁特性 Worktree]
```

1. **主目录角色**：仓库根目录（`/root/SuperIU`）保持在 `master`，作为纯净基准控制台，不作日常脏修改。
2. **特性工位（Worktree）**：从最新的 `origin/master` 创建短命特性 worktree（例如 `feat/xxx` 或 `fix/xxx`）。
3. **发版并合入**：
   * 在特性 worktree 中跑通单元测试与守卫检查（见第 4 节）；
   * 在特性分支上完成版本 bump 与双语 CHANGELOG 提交；
   * 将特性分支合入 `master`（提 PR squash-merge 或 fast-forward 推送）；
   * 在 `master` 的最新合并提交上打 tag 并推送：
     ```bash
     git tag v<ver> origin/master
     git push origin v<ver>
     ```
4. **生命周期闭环**：发版后**立即清理**该特性的 worktree 与本地特性分支。

## 3. wiki 写入的正确姿势

* `.wiki/skills/**` 是**被 git 跟踪**的普通文件；`.agents/skills/**` 是指向它的符号链接。改一处即可。
* **不同分支的同一路径是不同内容**：在 feature 分支改 wiki，`master` 上不会自动有。
  只有提交并合并进 `master` 后才真正生效。
* 因此"记到 wiki 了"当且仅当：改动出现在**被推送、且合进 `master`** 的树里。
* 写完 wiki 后自检：**别引用本分支不存在的段落**，写成自包含的句子。

## 4. 发布前/后的验证（"已触发" ≠ "已发布"）

发布**前**（在工作树内执行）：
```bash
pnpm install --frozen-lockfile && pnpm build
pnpm --filter @agent/desktop run typecheck && pnpm --filter @agent/ui run typecheck
npx vitest run            # 期望全绿；若只有若干失败，先用 git stash 在干净树复现，证明是否为既有偶发
node scripts/check-ui-i18n.mjs && node scripts/check-dict-parity.mjs   # 等 6 个守卫
```
> 注意：`pnpm --filter <pkg> run typecheck` 用 workspace 依赖时**需要先 `pnpm build`**。

发布**后**（唯一可称"发版完成"的证据）：
```bash
gh run view <run-id> -R Kayphoon/SuperIU --json status,conclusion    # 必须 completed/success
gh api repos/Kayphoon/SuperIU/releases/tags/v<ver> --jq '{draft,prerelease,published_at}'
gh api repos/Kayphoon/SuperIU/releases/tags/v<ver> --jq '.assets[].name'   # 资产齐全（mac zip+dmg+sha256、server linux x64/arm64+sha256）
git show v<ver>:packages/desktop/package.json | grep version        # tag 提交里的版本号正确
```
run 仍在 `in_progress`、或 release 返回 404 → 只能说**"已触发"**，不能说"已发布"。

## 5. 收尾纪律：生命周期终结与僵尸清理

* **特性 worktree 必须在发版完成后销毁**：
  ```bash
  git worktree remove <worktree-path>
  git branch -d <feature-branch>
  ```
* 严禁留存一次性分支；发版直接以 `v*` tag 锚定，不推 `release/*` 分支。
* 主目录保持与远程同步：
  ```bash
  git pull --ff-only origin master
  ```

## 相关知识

- [[wiki-architecture-one-core-two-shells]] — 桌面/远程工作目录推导等产品约定
- [[wiki-release-bilingual-changelog]] — 双语 CHANGELOG 强制守卫要求
