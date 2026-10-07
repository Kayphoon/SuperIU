# Changelog | 更新日志

All notable changes to SuperIU are documented here. Every release section must carry both Chinese and English notes (`### 中文` + `### English`). The release workflow extracts the matching section as the GitHub Release body — a missing or non-bilingual section fails the release.

SuperIU 的重要变更均记录于此。每个版本小节必须同时包含中文与英文说明（`### 中文` + `### English`）。发布流水线会提取对应小节作为 GitHub Release 正文——小节缺失或非双语将直接导致发布失败。

## Unreleased | 未发布

### 中文

- 暂无新变更；滚动 `latest` 渠道当前分发最近一个标签版本的内容。

### English

- No new changes yet; the rolling `latest` channel currently ships the most recent tagged release.

## v0.2.16 (2026-10-08)

### 中文

- 修复更新渠道遮蔽：应用内自动更新器与 `install-mac.sh` 此前只查询 `/releases/latest`，而该端点按 GitHub 规范永不返回预发布版本。本仓库同时存在「稳定 tag（vX.Y.Z）」与「每次推送 master 重建的滚动 `latest` 预发布」两条渠道，因此只要稳定 tag 落后于 master，新构建就会被旧 tag 遮蔽——用户会看到「已是最新」却拿不到新版本。
  - 更新器现在同时查询 `/releases/latest` 与 `/releases?per_page=30`，取两者中版本最高者（忽略 draft、无 macOS 资产、版本号无法解析的条目）；接口整体失败时仍安全返回「无更新」。
  - `install-mac.sh` 改为查询发布列表并按 `sort -V` 取最高版本的 mac zip，列表为空时才回退到 `/releases/latest`。
- 修复 `install-mac.sh` 的死回退路径：此前 API 限流时回退构造的 `.../releases/latest/download/SuperIU-mac-arm64.zip` 因资产名内嵌版本号而**必然 404**。现在该构造仅在你显式设置 `SUPERIU_RELEASE_BASE` 时使用，否则脚本会给出明确错误并退出，而不是下载一个 404。

### English

- Fix release-channel shadowing: the in-app updater and `install-mac.sh` queried only `/releases/latest`, which by GitHub's specification never returns pre-releases. This repo publishes both tagged stable releases (vX.Y.Z) and a rolling `latest` prerelease rebuilt on every master push, so whenever a stable tag lags behind master the newer build is shadowed by the older tag — users saw "already newest" while a new version was published.
  - The updater now queries both `/releases/latest` and `/releases?per_page=30` and takes the highest version across them (ignoring drafts, asset-less releases, and unparseable versions); a total API failure still safely reports "no update".
  - `install-mac.sh` now queries the release list and picks the highest-versioned mac zip via `sort -V`, falling back to `/releases/latest` only when the list is empty.
- Fix the dead fallback in `install-mac.sh`: the URL it constructed under API rate-limiting (`.../releases/latest/download/SuperIU-mac-arm64.zip`) provably 404s because real asset names embed the version. That construction is now used only when you explicitly set `SUPERIU_RELEASE_BASE`; otherwise the script fails with a clear error instead of downloading a 404.

## v0.2.15 (2026-10-08)

### 中文

- 重做远程/网关连接状态窗口（`gatewayStatusHtml`）：从几行灰色调试文本（`Step: workspace — active`、`Status: connecting`）改为状态卡片式界面——语义化主状态（连接中 / 已连接 / 失败 / 已断开，含配色圆点与进度条）、7 步部署进度的中文步骤名与「第 N 步，共 7 步」、连接信息（SSH 主机 / 远程工作区 / 网关地址）与本地工作区分区呈现，原始内部状态降为页脚「技术状态」。
- 状态窗口文案跟随界面语言（`uiLanguage`）中英双语，`<html lang>` 同步切换；失败详情改为限高可滚动块（原始 ssh / probe 输出不再整段撑开页面），并保持深色/浅色与「减少动态效果」适配。
- 修复状态窗口在 540×600 窗口与默认窗口下的溢出：新增短视口紧凑布局，内容不再被推出屏幕。

### English

- Redesign the remote/gateway connection status window (`gatewayStatusHtml`): replace the few grey debug lines (`Step: workspace — active`, `Status: connecting`) with a status-card layout — a semantic headline (connecting / connected / failed / disconnected, with a coloured dot and progress track), the 7-step deployment progress with human step names and "Step N of 7", and separated connection (SSH host / remote workspace / gateway URL) and local-workspace cards. The raw internal state drops to a "Technical status" footer.
- Localize the status window copy to the UI language (`uiLanguage`), switching `<html lang>` accordingly; render a failed step's detail in a height-capped scrollable block (raw ssh/probe output no longer stretches the page) while keeping dark/light and reduced-motion support.
- Fix overflow of the status window at the 540×600 wizard size and the default window: a compact layout for short viewports keeps the content on screen.

## v0.2.14 (2026-10-07)

### 中文

- 优化 macOS 生产与本地开发应用隔离：本地开发构建 (`pnpm app:install`) 自动命名为 `SuperIU (Dev).app` 并分配独立 Bundle ID (`com.superiu.desktop.dev`)，与系统生产应用彻底分离；Dev 变体自动豁免生产更新检查。
- 增强 macOS 脚本安装与更新 (`scripts/install-mac.sh`)：新增本地已安装版本与远端版本比对短路机制，已是最新版本时跳过 170MB 重复下载（支持 `FORCE=1` 强制重装）；安装前自动清理 `~/Applications` 下的旧版本冲突残留。

### English

- Isolate macOS production vs local development app bundles: local dev install (`pnpm app:install`) is now branded as `SuperIU (Dev).app` with bundle ID `com.superiu.desktop.dev` and exempt from production auto-updates, completely separating dev builds from `/Applications/SuperIU.app`.
- Enhance macOS shell installer/updater (`scripts/install-mac.sh`): add local-vs-remote version comparison to skip downloading when already on the latest release (with `FORCE=1` override option); automatically purge conflicting legacy dev bundles from `~/Applications` before installing.

## v0.2.13 (2026-10-07)

### 中文

- 标题栏增加连接状态徽标与往返延迟显示：本地模式展示静音徽标；远程 VPS 模式显示主机别名与真实 RTT 延迟（如 `● arm · 42ms`），断线或重连时即时呈现实时状态（`○ arm · 正在重连…`）。
- 服务端与桌面客户端打通 WebSocket 往返延迟（RTT）主动采样与状态机事件广播（`connecting` / `connected` / `reconnecting` / `closed`），不再静默失联。
- 设置「远程 VPS」面板增加「已连接主机」卡片，直观呈现当前主机、远端目录、本地转发端口与网络延迟，并提供「断开并切换主机」完整交互。

### English

- Add connection status indicator and round-trip latency to Titlebar: shows quiet badge in local mode, and host alias with real RTT latency in remote VPS mode (e.g. `● arm · 42ms`), switching instantly on reconnect or drop (`○ arm · Reconnecting…`).
- Implement active WebSocket RTT latency measurement and forward GatewayClient connection state events (`connecting` / `connected` / `reconnecting` / `closed`) through IPC to the web console.
- Add "Currently Connected" status card to Remote VPS settings pane, showing connected host alias, remote workspace, local forwarding port, latency, and a functional "Disconnect & Switch Host" action.

## v0.2.12 (2026-10-07)

### 中文

- 修复远程模式连接过程中窗口长期定格在「Step: probe — active / Status: connecting」的问题：状态页此前是一张不含脚本的静态页面，7 步部署流程的进展只发往 IPC 而无人消费。现在状态页会随每一步实时刷新，用户能看到 probe → install → workspace → token → start → tunnel → client 的真实进度。
- 为远程 Web 控制台增加导航自愈：连接建立后若页面导航失败（端口尚未就绪、隧道重启等），会在 60 秒内按指数退避（500ms → 5s）自动重试；渲染进程异常退出时自动重载（最多 3 次）。超过上限后显示明确的失败页面，不再静默停留在旧画面。
- 新增 `packages/desktop/src/remote/navigation.ts` 纯函数策略模块与配套单元测试。

### English

- Fix the remote-mode window freezing on "Step: probe — active / Status: connecting". The status page was a scriptless static page, and the 7-step deployment progress was sent over IPC with no consumer. It now repaints on every step, so the real probe → install → workspace → token → start → tunnel → client progress is visible.
- Add navigation self-healing for the remote web console: after connecting, a failed page navigation (port not yet ready, tunnel restart, …) retries with exponential backoff (500ms → 5s) for up to 60 seconds, and an abnormally exited renderer is reloaded (max 3 times). Past those limits an explicit failure page is shown instead of silently keeping a stale frame.
- Add the pure-policy module `packages/desktop/src/remote/navigation.ts` with unit tests.

## v0.2.11 (2026-10-06)

### 中文

- 修复 SSH 隧道在用户 `~/.ssh/config` 存在其他冲突 LocalForward 配置时的异常退出问题（改为 ExitOnForwardFailure=no）。
- 支持多行格式远程 daemon `server.json` 解析。

### English

- Fix SSH tunnel failure when user's `~/.ssh/config` contains other conflicting LocalForward ports (use ExitOnForwardFailure=no).
- Support parsing multiline daemon `server.json` files from the remote host.

## v0.2.10 (2026-10-06)

### 中文

- 远程 VPS 模式下，桌面窗口在连接成功后直接加载隧道端点处的完整智能体控制台界面，实现客户端对话交互与云端 Agent 运行。

### English

- In remote VPS mode, load the full agent console in the desktop window via the tunnel endpoint upon successful connection for direct desktop chatting with the remote agent.

## v0.2.9 (2026-10-06)

### 中文

- 首次启动引导页面（Onboarding）顶部使用原生 SuperIU 应用图标（自包含 Base64 嵌入，适配明暗模式与 macOS 窗口拖拽区域）。
- 适配 Web 控制台移动端屏幕与粗指针触控体验：支持会话抽屉折叠、动态视口高度（`--siu-vvh`）与全面屏安全区避让，优化软键盘呼起时的布局与 IME 输入法合成行为。
- 完善首次启动向导中远程 VPS 工作区默认路径说明文档。

### English

- Use the native SuperIU application icon in the first-run onboarding wizard (self-contained Base64 embed, calibrated for light/dark themes and macOS window drag regions).
- Adapt Web console for mobile viewports and touch interaction: off-canvas drawer sidebar, dynamic visual viewport height (`--siu-vvh`), notch/safe-area insets, and fix IME composition Enter key handling in composer input.
- Document remote VPS workspace pre-fill behavior in first-run onboarding guidance.

## v0.2.8 (2026-10-05)

### 中文

- 修复 SSH 本地端口转发在默认端口 0 时的规格错误（Bad local forwarding specification），将无效端口及 0 自动解析为操作系统分配的空闲端口。

### English

- Fix SSH local port forwarding specification failure on port 0 by treating invalid and zero ports as ephemeral requests and dynamically picking an OS-assigned free port.

## v0.2.7 (2026-10-05)

### 中文

- 修复远程 VPS 连接向导的工作区默认路径未生效的问题。

### English

- Fixed the remote VPS connection wizard not applying its default workspace path.

## v0.2.6 (2026-10-05)

### 中文

- 首次运行引导（onboarding）现可触达滚动更新渠道的已有客户端。

### English

- First-run onboarding now reaches existing clients on the rolling update channel.

## v0.2.5 (2026-10-05)

### 中文

- 桌面端发布产物同时提供 DMG 与 ZIP 双格式分发。

### English

- Desktop release artifacts now ship in both DMG and ZIP formats.

## v0.2.4 (2026-10-05)

### 中文

- 修复远程 VPS 安装包下载指向错误仓库的问题。

### English

- Fixed remote VPS downloads pointing at the wrong publishing repository.

## v0.2.3 (2026-10-03)

### 中文

- 远程 VPS 工作区路径默认值现在会被正确应用。

### English

- The remote VPS workspace path default is now applied correctly.

## v0.2.2 (2026-10-03)

### 中文

- 固定偏好设置窗口高度，修复设置子菜单跳动的问题。

### English

- Pinned the preferences window height so the settings submenu stops jumping.

## v0.2.0 (2026-10-01)

### 中文

- 更新器现在选择最高版本的 macOS 产物，并清理滚动渠道中的过期产物。

### English

- Updater now selects the highest-version macOS asset and prunes stale rolling-channel assets.
