---
name: wiki-release-process
description: |
  SuperIU 发版流程与分支基线纪律
  - 发版前**必须先核对基线**：`git fetch` 后比对 `origin/master`，绝不假定当前工作树是最新
  - 版本号 bump 的唯一位置 packages/desktop/package.json（tag 触发 CI）
  - `.wiki/` 与 CI 看到的 `master` 不是同一个工作树；wiki 只写进被提交并推送的树才有意义
  - 发布前「已发布」的证据：run completed + release 对象 + 资产清单（不是"已触发"）
---

# SuperIU 发版流程与基线纪律

## 0. 铁律：先核对基线，再动手

**症状**（本仓库反复出现）：改了 A，却没发现 `master` 上早已有 A 的更新版本 / 相反决策 / 相关修复。
根因不是记性差，而是**一直以某个落后的工作树为基线**（例如长期停在 `Kayphoon/torpedo`，落后 `master` 十余个提交）。

发版或任何跨文件改动**之前**必须先做：

```bash
git fetch origin --tags
git rev-list --left-right --count origin/master...HEAD   # 左=master 独有（你看不见的），右=本分支独有
git log --oneline HEAD..origin/master                    # 逐条看 master 上有什么
```

* **「左」不为 0 就是危险信号**：说明 `master` 上有对本工作树不可见的工作。此时：
  * 先读这些提交，判断是否与本次改动冲突/重复/已被修复；
  * 发版务必从 `origin/master` 派生（worktree 或 merge），**不要**在落后分支上直接打 tag。
* 判断某个"约定/修复是否已存在"时，**必须查 `origin/master`**，不是当前工作树：
  ```bash
  git show origin/master:<path> | grep -n <关键词>
  git log --oneline -S '<关键词>' origin/master -- <path>
  ```
  用落后的工作树 grep 会给出**假阴性**（"没有记录"实际上是"我这份副本太旧"）。

**实例（本仓库已发生）**：`remoteWorkspaceDefault` 的宿主推导、其 wiki 记录（"绝不能用 `~`"）、
ditto→`fs.cp` 回退、以及 0.2.2~0.2.5 的版本号，全部在 `master` 上（`f5cb51b` / `fcd1223` / …），
而 `Kayphoon/torpedo` 一个都看不见。以它为基线导致同一处返工三轮。
（`master` 的 wiki 副本与工作树副本是**同一物理文件**，但不同分支的副本不同——见第 3 条。）

## 1. 版本号与发布触发

* **唯一位置**：`packages/desktop/package.json` 的 `version`。bundle 名 `SuperIU-<version>-mac-<arch>.zip|dmg`
  与自动更新客户端的比较都读它（`bundle-mac.ts` 从 package.json 读 version）。
* 触发方式（`.github/workflows/release.yml`）：
  * push tag `v*` → 正式 Release（`prerelease: false`），运行 `release` job；
  * push `master` → 滚动 `latest`（`prerelease: true`），会先清空旧资产。
* **已安装客户端只在版本号变化时才看到更新**——所以任何要交付的修复都必须 bump，不能复用已发布的版本号。
  bump 单独一个提交，信息里说明"为什么必须 bump"（惯例：`92f537e` / `08a2c4a` / `a169d6c` / `92f537e`）。
* `fail_on_unmatched_files: true`：mac 打包失败会让**整条** release 失败且不发任何资产。

## 2. 从 `origin/master` 派生（不要复用落后分支）

```bash
git fetch origin
git worktree add -b release/<ver> /tmp/siu-rel origin/master   # 从真正的 master 派生
cd /tmp/siu-rel
git cherry-pick <本特性提交…>                                  # 只搬本特性的提交
# 解决冲突（常见于 .wiki 文档），bump version，提交
```

* 用 **worktree** 而非切分支：可避免覆盖工作树里**用户未提交的改动**（本项目常见）——
  `git checkout` 会拒绝并中止，那是保护，不是故障。
* cherry-pick 冲突多发生在 `.wiki/**`（文档累积），取"目标分支已有 + 本次新增"的并集，别整段覆盖。

## 3. wiki 写入的正确姿势

* `.wiki/skills/**` 是**被 git 跟踪**的普通文件；`.agents/skills/**` 是指向它的符号链接。改一处即可。
* **但不同分支的同一路径是不同内容**：在 `ferature` 分支改 wiki，`master` 上不会自动有。
  只有提交并推送（合并）后才真正生效。
* 因此"记到 wiki 了"当且仅当：改动出现在**被推送、且合进 `master`** 的树里。只写在工作树 / 只写在对话里
  = **没记录**。写完 `git status` 确认它已被 commit。
* 写完 wiki 后自检：**别引用本分支不存在的段落**（例如写"见上条「某某」"，而该条只在 `master` 上）——
  写成自包含的句子。

## 4. 发布前/后的验证（"已触发" ≠ "已发布"）

发布**前**（release 树上）：
```bash
pnpm install --frozen-lockfile && pnpm build
pnpm --filter @agent/desktop run typecheck && pnpm --filter @agent/ui run typecheck
npx vitest run            # 期望全绿；若只有若干失败，先用 `git stash` 在干净树复现，证明是否为既有偶发
node scripts/check-ui-i18n.mjs && node scripts/check-dict-parity.mjs   # 等 6 个守卫
```
> 注意 `pnpm test` 会在第一个失败处中止，其后脚本不跑；要逐条手动跑上面 6 个脚本步。
> `pnpm --filter <pkg> run typecheck` 用 workspace 依赖时**需要先 `pnpm build`**（它解析的是 `dist/*.d.ts`）。

发布**后**（唯一可称"发版完成"的证据）：
```bash
gh run view <run-id> -R Kayphoon/SuperIU --json status,conclusion    # 必须 completed/success
gh api repos/Kayphoon/SuperIU/releases/tags/v<ver> --jq '{draft,prerelease,published_at}'
gh api repos/Kayphoon/SuperIU/releases/tags/v<ver> --jq '.assets[].name'   # 资产齐（mac zip+dmg+sha256、server linux x64/arm64+sha256）
git show v<ver>:packages/desktop/package.json | grep version        # tag 提交里的版本号正确
```
run 仍在 `in_progress`、或 release 返回 404 → 只能说**"已触发"**，不能说"已发布"。

## 5. 收尾

* 不在 `master` 上直接发版时，一定要交出**唯一**的合并目标分支，并**删除**中间遗留分支
  （每轮实验都会留下 `release/x-v2` 之类），否则用户面对多个链接不知道合哪个：
  ```bash
  git ls-remote --heads origin | grep release/
  git push origin --delete <废弃分支>
  ```
* `origin/Kayphoon/torpedo` 之类长期分支若已落后，要么推送它、要么在报告里明确说明它与发布分支的关系，
  不要留下"以为推送了其实没有"的歧义。

## 相关知识

- [[wiki-architecture-one-core-two-shells]] — 桌面/远程工作目录推导等产品约定
