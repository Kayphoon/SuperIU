# Changelog | 更新日志

All notable changes to SuperIU are documented here. Every release section must carry both Chinese and English notes (`### 中文` + `### English`). The release workflow extracts the matching section as the GitHub Release body — a missing or non-bilingual section fails the release.

SuperIU 的重要变更均记录于此。每个版本小节必须同时包含中文与英文说明（`### 中文` + `### English`）。发布流水线会提取对应小节作为 GitHub Release 正文——小节缺失或非双语将直接导致发布失败。

## Unreleased | 未发布

### 中文

- 暂无新变更；滚动 `latest` 渠道当前分发最近一个标签版本的内容。

### English

- No new changes yet; the rolling `latest` channel currently ships the most recent tagged release.

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
