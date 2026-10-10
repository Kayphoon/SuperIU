# Changelog | 更新日志

All notable changes to SuperIU are documented here. Every release section must carry both Chinese and English notes (`### 中文` + `### English`). The release workflow extracts the matching section as the GitHub Release body — a missing or non-bilingual section fails the release.

SuperIU 的重要变更均记录于此。每个版本小节必须同时包含中文与英文说明（`### 中文` + `### English`）。发布流水线会提取对应小节作为 GitHub Release 正文——小节缺失或非双语将直接导致发布失败。

## Unreleased | 未发布

### 中文

- 暂无新变更；滚动 `latest` 渠道当前分发最近一个标签版本的内容。

### English

- No new changes yet; the rolling `latest` channel currently ships the most recent tagged release.

## v0.2.49 (2026-10-10)

### 中文

- 支持 AI SDK 原生多格式模型调用（支持 Anthropic Claude Messages 格式与 Google Gemini Generative AI 格式，与原有的 OpenAI Chat Completions 格式并存）：
  - **核心多格式适配器与路由**：在 `@agent/core` 中引入 `@ai-sdk/anthropic` 与 `@ai-sdk/google`，实现 `resolveProviderType` 路由解析器与 `AgentRunner.createLanguageModel` 多格式工厂；支持通过 `route.provider` 显式路由，或按端点特征及模型前缀智能推导提供商类型；
  - **各厂商推理与深度思考参数适配**：在 `AiSdkStepAdapter` 中统一标准化推理/思考参数分发机制——为 Anthropic 自动组装 `thinking: { type: 'enabled', budgetTokens }` 并智能对齐 `maxTokens` 门槛，为 Google 自动组装 `thinkingConfig: { thinkingBudget }`，为 OpenAI 保持 `reasoningEffort`；在模型能力探测器中支持 Claude 3.7 Sonnet 混合思考模型；
  - **UI 服务端与模型探测请求头增强**：在 `packages/ui` 中将活跃服务商（`activeProviderId`）注入运行配置；在 `/api/models/fetch` 探测逻辑中对 Anthropic 端点补齐 `x-api-key` 与 `anthropic-version: 2023-06-01` 鉴权头；
  - **完整测试验证与向下兼容**：新增多提供商路由及模型实例构建单元测试，确保 OpenAI 兼容端点、Gemini OpenAI 代理端点及纯本地端点行为无缝兼容。

### English

- Support native multi-provider and multi-format model calling via Vercel AI SDK (Anthropic Messages format and Google Generative AI format alongside OpenAI Chat Completions):
  - **Core Multi-Provider Adapters & Routing**: Added `@ai-sdk/anthropic` and `@ai-sdk/google` to `@agent/core`, introducing `resolveProviderType` and `AgentRunner.createLanguageModel` to dispatch between Anthropic, Google, and OpenAI-compatible providers either via explicit `route.provider` or via heuristic endpoint and model prefix detection;
  - **Provider-Specific Reasoning and Thinking Options**: Standardized reasoning effort mapping across providers in `AiSdkStepAdapter`—configuring Anthropic extended thinking (`thinking: { type: 'enabled', budgetTokens }`) with automatic `maxTokens` budget alignment, Google `thinkingConfig: { thinkingBudget }`, and OpenAI `reasoningEffort`; added `claude-3-7-sonnet` to the reasoning model allowlist;
  - **UI Server & Model Fetch Headers**: Injected active provider id into runner options; added Anthropic-specific authentication headers (`x-api-key` and `anthropic-version: 2023-06-01`) to `/api/models/fetch` probes when querying Anthropic endpoints;
  - **Comprehensive Test Coverage & Backwards Compatibility**: Added unit test coverage for provider resolution, capability guards, and language model instantiation while ensuring existing OpenAI-compatible proxies and endpoints remain fully backwards-compatible.

## v0.2.48 (2026-10-10)

### 中文

- 修复配对时预设设备名称/备注被客户端 User-Agent 强行覆盖的问题：
  - **修正配对凭证消费时的设备名称优先级判定**：解决在 `store.consumeCode` 与 `handleConnectCode` 中因客户端自动嗅探的 User-Agent 字符串（如 `Mac`、`iPhone`）非 `web` 而被错误当作显式自定义名称、进而粗暴覆盖管理员在生成配对码时显式指定的备注名称（如 `iPhone Air`）的严重缺陷；确立「显式覆盖参数 > 配对码预设备注名称 > UA 启发式名称 > web 回落」的绝对优先级；
  - **增强配对链接 URL 显式参数传递**：在 `mintConnectCode` 及 CLI `superiu-server pair` 生成的配对链接中同步附带 `?label=...` 查询参数，确保异构浏览器在打开链接时双重保障设备名称不丢失；
  - **优化配对面板交互文案提示**：将「目标设备名称 / 备注」调整为「新设备名称 / 备注」，并完善字段解释文案，消除已存在设备用户对预备注输入框用途的困惑，同时明确现有已授权设备可随时点击卡片右侧「重命名」进行修改。

### English

- Fix pre-assigned device name/remark being overwritten by client User-Agent heuristics during pairing:
  - **Correct device label priority during code consumption**: fixed a critical bug in `store.consumeCode` and `handleConnectCode` where an auto-detected User-Agent header (e.g. `Mac`, `iPhone`) was incorrectly treated as an explicit consumer-provided label, completely overriding the administrator's pre-assigned device remark (e.g. `iPhone Air`); established strict precedence: explicit override parameter > code pre-assigned remark > UA heuristic > fallback;
  - **Propagate label query in minted pairing URLs**: include `?label=...` query parameters in links produced by `mintConnectCode` and `superiu-server pair` for dual-layer label preservation across heterogeneous browsers;
  - **Refine pairing settings copy and hints**: updated field copy to "New Device Name / Label" with clear guidance, clarifying that the field pre-assigns the name for new pairing codes and reminding users that existing devices can be renamed directly via the "Rename" action.

## v0.2.47 (2026-10-10)

### 中文

- 恢复经典原生纯白 Big Sur 卡片图标资产并强化 Web 静态资源强缓存防御：
  - **恢复纯白原生 Squircle 卡片应用图标**：彻底将 `packages/ui/public/app-icon.png` 与 `packages/desktop/src/views/app-icon.png` 恢复为原生内置纯白圆角卡片（与 macOS `.app` bundle 资产完全对齐），消除 CSS 外挂渐变背景导致的主题残留，同时还原欢迎界面 `.siu-empty-icon` 原生投影与洁白质感；
  - **增强 HTML 入口文件防缓存机制**：在服务端静态资源服务中对所有 `.html` 响应强制注入 `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0` 响应头，彻底杜绝 iOS Safari 与 PWA 容器因强力缓存导致的旧版前端样式滞留问题。

### English

- Restore classic native all-white Big Sur squircle app icon and strengthen Web cache defenses:
  - **Restore native all-white squircle card assets**: restored `packages/ui/public/app-icon.png` and `packages/desktop/src/views/app-icon.png` back to the native built-in white squircle card (perfectly aligned with macOS `.app` bundle master assets), eliminating theme drift from synthetic CSS gradients and restoring clean native elevation shadows for `.siu-empty-icon`;
  - **Strengthen HTML entry-point cache busting**: explicitly send `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0` for all `.html` responses from the UI server, preventing iOS Safari and PWA containers from serving stale cached shell layouts.

## v0.2.46 (2026-10-10)

### 中文

- 修复设置关于面板单端远程升级按钮被隐藏的问题：
  - **修复按钮原生 DOM 隐藏属性残留**：修正更新动作按钮在移除 `hidden` CSS 类时未同步将 HTML 原生 `hidden` 属性设为 `false` 的问题，确保远程网关有新版本时卡片右侧的「立即升级」按钮正常展示并可点击；
  - **双端联动栏适配仅远程有更新场景**：当本地客户端已是最新版本、仅远程网关发现新版本时，底部主操作栏自动浮现「⚡ 升级远程网关」操作按钮，消灭全屏无处可点升级的盲区。

### English

- Fix missing remote upgrade action button on About settings panel:
  - **Synchronize native DOM hidden attribute**: fixed an issue where removing the `hidden` CSS class failed to set the native HTML `hidden` property to `false`, ensuring the "Upgrade Remote" button on the remote gateway card is visible and clickable when an update is available;
  - **Surface dual-action bar on remote-only updates**: added dedicated rendering for cases where the local client is already up-to-date while the remote gateway has a pending release, rendering the "⚡ Upgrade Remote Gateway" master button.

## v0.2.45 (2026-10-10)

### 中文

- 支持设备配对自定义命名与已授权设备重命名：
  - **连接屏支持设备命名**：控制台配对登录屏新增「设备名称」（可选）输入框，连接时可输入自定义设备名（例如：“MacBook Air”、“办公室电脑”）；留空时优先继承发码者预设的目标名称，或根据 User-Agent 智能识别系统类型（`Mac`、`iPhone`、`Windows` 等），摆脱单一默认标识；
  - **为他机发码支持预设目标设备名**：设置第 8 面板“为其他设备发码”新增「目标设备名称 / 备注」输入项，生成的配对码将绑定该名称，配对单次链接卡片展示目标设备徽标，被授权设备连接后自动继承；
  - **已授权设备列表支持随时重命名**：设备管理列表各设备项新增「重命名」操作入口，配合 `PATCH /api/pairing/:id` 接口实现名称持久化修改；
  - **CLI 命令行扩展**：`superiu-server pair` 支持 `--name <label>` 预设配对设备名，以及 `--rename <id> --name <new-name>` 在终端直接重命名已有设备。

### English

- Support custom device naming during pairing and device renaming:
  - **Device naming on connect screen**: added optional "Device Name" input to the console pairing form, allowing users to label new connections (e.g., "MacBook Air", "Office PC"); defaults to pre-assigned target name or intelligently infers platform via User-Agent (`Mac`, `iPhone`, `Windows`, etc.) instead of generic labels;
  - **Pre-assigned target device name when minting codes**: added "Target Device Name" input to the pairing code generator in Settings panel 8, associating minted codes with target names and displaying a target badge on the one-time link card;
  - **Device renaming in authorized devices list**: added a "Rename" action button for each entry in the authorized devices list backed by `PATCH /api/pairing/:id` for persistent updates;
  - **CLI command additions**: extended `superiu-server pair` with `--name <label>` to name new pairing codes and `--rename <id> --name <new-name>` to rename existing keys directly from the terminal.

## v0.2.44 (2026-10-10)

### 中文

- 修复 iOS Safari 抽屉交互卡死与 PWA 图标外圈暗环：
  - **移动端抽屉交互与点击响应修复**：修复移动端媒体查询样式块中因注释未闭合导致的 CSS 解析语法错误；修复后移动端抽屉正常恢复为左侧悬浮抽屉布局，并将顶部标题栏层级提升至遮罩层之上，彻底解决点击左上角消息列表按钮或 `<` 收起按钮无响应卡死的问题；
  - **PWA 主屏幕图标外圈暗环消除**：为 Safari / PWA 独立生成 512×512 满幅纯白底色 `apple-touch-icon.png`，消除 iOS 自动添加主屏幕图标时因外围透明边距被系统默认填充为黑色所导致的暗色外圈；
  - **欢迎界面头像底板回归经典纯白卡片**：去除头像外框双层边框与暗色叠加，恢复为经典纯白圆角卡片配柔和环境微投影，在暗夜模式下更加通透美观。

### English

- Fix iOS Safari drawer freeze and eliminate PWA dark icon outer ring:
  - **Mobile drawer interaction & tap responsiveness fix**: resolved a CSS syntax error caused by an unclosed comment in the mobile media query; properly restores the off-canvas drawer layout and elevates the chrome z-index above the scrim, fixing the issue where tapping the sidebar toggle or `<` collapse button was stuck and non-responsive;
  - **Safari PWA home-screen icon dark ring elimination**: generated a solid-bleed 512x512 opaque white `apple-touch-icon.png` for Safari and PWA manifest, preventing iOS from automatically filling transparent margins with black when added to the home screen;
  - **Classic all-white squircle card for welcome avatar**: removed double border rings and dark mode tint on the avatar card, restoring the clean all-white Apple-style squircle card with gentle elevation shadow for a crisp appearance against dark backgrounds.

## v0.2.43 (2026-10-10)

### 中文

- 极简化更新体验与解耦双端升级流水线：
  - **彻底移除阻塞模态弹窗**：删除桌面端在后台下载完后跳出的原生 Changelog 模态对话框（`dialog.showMessageBox`），下载完成仅保留轻量系统通知，右上角标题栏绿色药丸按钮成为唯一的非侵入式确认重启控制点；
  - **异步化更新检查与下载**：将桌面端 `checkForUpdate` 的下载过程异步化，消除上层并发自检时的长时间假死；
  - **设置关于面板进入即并发自检刷新**：打开或切换至关于面板时自动重新并发拉取本地与远程最新版本，打破旧状态缓存；
  - **双端生命周期彻底解耦**：移除双端模式下强行隐藏卡片操作按钮的垄断逻辑；远程有新版本时随时可独立执行平滑升级（无需等待本地下载），本地下载就绪后随时可重启换装，双端并行互不锁死。

### English

- Streamline update pipeline and decouple dual-end update flow:
  - **Eliminate blocking modal dialogs**: removed desktop native Changelog `dialog.showMessageBox` upon download completion, keeping non-intrusive system notifications and leaving the titlebar green pill button as the sole explicit restart action;
  - **Asynchronous check and preparation**: decoupled download execution in `checkForUpdate` so upper-level update checks return promptly without locking up the UI;
  - **Immediate concurrent refresh on About panel**: automatically fetches fresh status for both local and remote nodes upon opening the About pane, eliminating stale cache blind spots;
  - **Decoupled dual-end lifecycle**: removed artificial button suppression in dual mode; remote gateway can be upgraded smoothly at any time without waiting for local macOS bundle downloads, and local client restarts independently without deadlocks.

## v0.2.42 (2026-10-10)

### 中文

- 优化标题栏网络延迟与远程连接状态徽标排版：
  - **解耦主机别名与延迟数字**：将主机别名与 RTT 延迟数字拆分为独立微胶囊徽标，消除字符串堆叠与多重硬分割线的拥挤感；
  - **自适应延迟质量与警示状态**：引入等宽微胶囊数字展示（`tabular-nums` 防抖动），根据网络质量动态呈现语义化着色预警（>250ms 预警 / >800ms 较差）；
  - **主机名优雅截断与全量悬停提示**：为长主机名/自定义地址提供优雅文本截断保护，悬停时通过原生 Tooltip 展示完整主机信息与实时毫秒延迟。

### English

- Refine titlebar network latency and remote connection status layout:
  - **Decoupled host alias & latency readout**: split host alias and RTT latency into dedicated micro-capsule badges, eliminating string concatenation and harsh divider crowding;
  - **Adaptive latency quality & alert states**: introduced monospace tabular-nums micro-pill indicators with semantic quality tinting (>250ms warning, >800ms poor);
  - **Hostname truncation & hover tooltips**: added graceful truncation protection for long hostnames or custom URLs, backed by native hover tooltips revealing full host targets and exact millisecond latency.

## v0.2.41 (2026-10-10)

### 中文

- 移动端 iOS / Safari / PWA 视口修复与暗色自适应透明图标优化：
  - **移动端视口高度与底部黑条修复**：修复 iOS Safari / PWA 在未弹起软键盘时被 `visualViewport` 误扣减安全区高度导致页面截断留黑的问题；仅在真正聚焦输入框时动态伸缩，并为 `html, body` 兜底应用全屏主题底色；
  - **顶部状态栏模糊消除与桌面按钮隐藏**：废除 iOS 会强制产生顶部磨砂模糊条的 `black-translucent` 属性，切换为与主题色无缝契合的 `default` 模式；在 `<=640px` 移动端自适应隐藏 macOS 桌面专用红黄绿窗口控制按钮；
  - **欢迎界面光晕与滚动遮罩精准定位**：收敛移动端背景光晕尺寸并正中锚定于头像之后，避免在暗色模式下溢出为顶部暗斑；为滚动遮罩添加滚动性条件校验，避免初始空状态误触发顶部淡出；
  - **透明底头像与暗色自适应圆角底板**：消除应用图标 PNG 外围硬编码白底并做抗锯齿除边，升级为纯净透明底；头像外框卡片由 CSS 驱动自适应主题——浅色下为温润白卡片，暗色下自动换装为深色微渐变卡片并伴随发丝微光边缘，完美融入暗夜模式。

### English

- Mobile iOS / Safari / PWA viewport fixes and dark-mode adaptive transparent icon:
  - **Mobile viewport height & bottom black chunk fix**: fixed an issue on iOS Safari / PWA where `visualViewport` subtracted safe area insets while idle and cropped the app height, leaving a dead black block at the bottom; now dynamically tracks the viewport only when the soft keyboard is actively focused, with full-bleed background coverage on `html, body`;
  - **Top status bar blur elimination & desktop traffic light suppression**: replaced `black-translucent` with `default` status bar styling aligned to `#0a0c11` dark theme-color, removing the artificial frosted blur band across the top; hid macOS window traffic light buttons on mobile screens (`<=640px`);
  - **Refined ambient aura & scroll mask guarding**: centered and scaled the ambient glow aura directly behind the avatar to eliminate smudge artifacts on small screens, and guarded transcript scroll edge fading so the top mask is never falsely triggered on non-scrolled empty states;
  - **Transparent avatar icon & theme-adaptive squircle card**: defringed and converted the avatar PNG to a 100% transparent-background image, and shifted the squircle card styling to CSS so it dynamically adapts to dark mode (sleek dark gradient squircle with rim lighting) and light mode (crisp white card).

## v0.2.40 (2026-10-10)

### 中文

- 修复网关交接便签构建类型安全与全平台流水线对齐：
  - 规范 `pending_resume.json` 中的 `leafId` 字段类型处理（`runner.getLeafId() ?? undefined`），解决 TypeScript 严格模式编译告警；
  - 确保 Linux（x64 / arm64）无头服务与 macOS 桌面客户端全目标自动化构建与发布顺利通过。

### English

- Fix resume marker type safety and align cross-platform release builds:
  - Normalize `leafId` field typing (`runner.getLeafId() ?? undefined`) in `pending_resume.json` to satisfy strict TypeScript compilation;
  - Ensure Linux (x64 / arm64) headless server and macOS desktop automated release builds pass cleanly across all targets.

## v0.2.39 (2026-10-10)

### 中文

- 网关更新软打断排空、接力便签机制与双端 1 小时周期轮询对齐：
  - **网关优雅排空换装与接力便签机制（Soft Drain & Resume Marker）**：当远程网关收到升级请求且当前正在执行会话任务时，废除原有的硬性 409 拒绝，转为优雅排空状态（`status: 'draining'`）；在当前轮次完成、完整响应已发给客户端且数据落盘后，原子写入 `.superiu/pending_resume.json` 交接便签，毫秒级重启换装并在开机时自动重新加载该会话，保障零数据丢失；
  - **网关自动更新轮询周期对齐至 1 小时**：将远程网关守护进程的默认空闲自动更新轮询周期从 6 小时调整为 1 小时（`DEFAULT_AUTO_UPDATE_INTERVAL_HOURS = 1`），与桌面端 1 小时轮询对齐；
  - **桌面端全局 1 小时后台轮询与开机静默延迟探查**：桌面端跨所有连接模式（本地、SSH 远程、网关、自定义地址）统一启用 30 秒冷启动延迟探测与 1 小时周期后台静默轮询，检测到新版本后自动后台增量下载并暂存，等待用户手动确认重启。

### English

- Gateway graceful drain update, session resume marker, and 1-hour polling alignment:
  - **Gateway graceful drain update with pending resume marker**: replaced hard 409 busy rejection with graceful drain mode (`status: 'draining'`) when an update request arrives mid-turn; upon turn completion with full response dispatched and messages persisted, atomically writes `.superiu/pending_resume.json` marker, performs millisecond restart, and automatically reloads the session upon startup for zero data loss;
  - **Align gateway update polling interval to 1 hour**: adjusted the gateway daemon's default idle auto-update polling interval from 6 hours to 1 hour (`DEFAULT_AUTO_UPDATE_INTERVAL_HOURS = 1`), matching desktop;
  - **Desktop global 1-hour periodic polling and silent startup probe**: enabled 30-second startup delay check and 1-hour silent periodic polling across all desktop connection modes, automatically staging differential downloads in the background and awaiting user restart confirmation.

## v0.2.38 (2026-10-10)

### 中文

- 桌面端首次启动向导重构与外部服务访问地址绑定支持：
  - **首次启动向导全新三卡片切换布局**：重构桌面端初始化向导 (`onboarding.html`) 为横向三卡片 Tab 栏设计（本地单机模式 / SSH 远程连接 / 自定义服务地址），支持一键直达对应配置表单，并新增自定义地址与 Token 直连支持（无需 SSH 隧道即可连通局域网或公网服务）；
  - **外部访问服务地址 (URL) 绑定与持久化**：在设置面板（远程 VPS 与设备配对）中新增「外部访问服务地址 (Web / iOS)」配置项，支持保存并在服务网关或 SSH 部署中同步；
  - **配对链接公网前缀优先注入**：生成一次性配对链接 (`/api/pairing/code`) 时，自动优先采用配置的外部服务地址（如公网 IP、反向代理域名或 Cloudflare Tunnel）作为 URL 前缀，彻底解决 SSH 隧道模式下因本地回环转发导致手机扫码或浏览器链接解析为 `127.0.0.1` 无法在外部设备打开的痛点；
  - **双语与本地化完全对齐**：新增中英文字典项并严格通过 UI 与双语一致性断言测试。

### English

- Desktop first-run onboarding redesign and external public service address binding:
  - **3-card tabbed onboarding layout**: redesigned the Desktop first-run wizard (`onboarding.html`) into a horizontal 3-card tabbed selector (Local / SSH Remote / Custom URL), allowing users to switch configuration panels in place, and added direct Custom URL and Token connection without requiring an SSH tunnel;
  - **External Service Address (URL) configuration & persistence**: added an "External Service URL (Web / iOS)" configuration field in Remote VPS and Pairing settings panes, persisting to gateway settings and runtime auth configuration;
  - **Public origin prefix injection for pairing links**: minted one-time pairing codes (`/api/pairing/code`) now prioritize the configured external public address (public IP, reverse proxy domain, or Cloudflare Tunnel) over local request hosts, resolving the issue where SSH-tunneled gateways minted `127.0.0.1` links unreachable from external iPhones or browsers;
  - **Bilingual localization & test alignment**: full English and Chinese dictionary coverage passing all static localization and consistency guards.

## v0.2.37 (2026-10-10)

### 中文

- 配对界面支持自定义服务地址与移动端 PWA / iOS Safari 独立应用适配：
  - **配对界面支持自定义 URL**：在控制台配对卡片中新增「服务地址 (URL)」专属输入框，支持直接指定远端服务（如局域网 IP、Docker 或穿透域名）；直接粘贴包含域名的完整配对链接时，自动将服务地址与凭据拆分填入；
  - **移动端与跨端无缝跳转**：在手机浏览器或 Web 端提交自定义地址时，自动通过顶级导航直达目标服务器完成验证并写入会话 Cookie，免受跨域限制；桌面端自动通过桌面桥接建立直连；
  - **iOS Safari PWA 独立应用适配**：新增 `apple-mobile-web-app-capable` 等元信息、深浅主题色与 Web App Manifest，支持从 Safari「添加到主屏幕」作为独立原生全屏 Web App 运行；补充 `favicon.ico` 根目录图标。

### English

- Pairing screen custom server URL input and mobile PWA / iOS Safari standalone web app adaptation:
  - **Custom Server URL on pairing card**: added a dedicated "Server URL" input to the console pairing card, enabling direct connection to remote instances (LAN IP, Docker, or reverse proxy domains); automatically splits origin and credential when pasting full pairing links;
  - **Seamless mobile & cross-origin navigation**: submitting a custom URL in browsers/mobile directly navigates to the target server to exchange tokens and establish cookies without CORS friction; desktop automatically connects and persists via the desktop bridge;
  - **iOS Safari PWA standalone web app support**: added `apple-mobile-web-app-capable` meta tags, adaptive theme colors, and Web App Manifest for running as a standalone fullscreen app when added to the home screen; provided root `favicon.ico`.

## v0.2.36 (2026-10-10)

### 中文

- 修复双端更新看板行内操作按钮未彻底隐藏的视觉问题：
  - **封堵双端模式幽灵按钮**：修复在重绘版本状态时 `className` 赋值意外抹除 `hidden` 类名、导致本地客户端行重复显示检查更新按钮且远程网关行残存空边框的缺陷；
  - **强制 CSS 隐藏层级**：为 `.siu-btn.hidden` 与 `.siu-btn[hidden]` 追加最高优先级隐藏，并在双端模式渲染周期显式确保两端行内按钮彻底隐藏，仅保留底栏统一主控。

### English

- Fix visual regression where per-node action buttons leaked in dual-end mode:
  - **Suppress phantom buttons in dual mode**: fixed an issue where resetting `className` inadvertently cleared the `hidden` class on update status redraws, causing a duplicate check button on the local node and an empty border frame on the remote node;
  - **Enforce CSS hidden specificity**: added `!important` to `.siu-btn.hidden` and `.siu-btn[hidden]`, explicitly guaranteeing that per-row action buttons remain hidden in dual mode with only the bottom master control visible.

## v0.2.35 (2026-10-10)

### 中文

- 重构设置「关于 / 产品更新」卡片交互与双端看板：
  - **单入口一键并发检查**：在双端连接（桌面客户端 + 远程网关）模式下，移除分端独立的检查更新按钮，由底栏单个「检查更新」按钮统一并发调度本地与远端检测，彻底解决需要点击两次的问题；
  - **双节点看板与右对齐排版**：采用独立悬浮节点卡片呈现双端状态，左侧展示专属节点图标（显示器 / 云端网关）、节点名称与从属别名 Chip（如 `arm`），右侧绝对同轴对齐 Mono 版本号徽章，配合实时健康状态指示灯（🟢/🔵/🟠/🔴）；
  - **自适应主控操作栏**：底栏主按钮根据双端组合状态自适应切换为「⚡ 一键升级双端」、「升级远程网关」或「立即重启以更新」，并在进入关于页时自动预拉取远端更新信息。

### English

- Redesign About / Product Update card interaction and dual-node board:
  - **Single unified concurrent check**: in dual-end mode (desktop client paired with remote gateway), removed per-row check buttons in favor of a single unified "Check for Updates" action that checks both local and remote nodes concurrently, eliminating the need to click twice;
  - **Dual-node board and right-aligned layout**: native floating node cards display each node with dedicated icons (desktop display / cloud gateway), node title, and gateway alias chip (e.g. `arm`), with right-aligned mono version badges and real-time status indicator dots (🟢/🔵/🟠/🔴);
  - **Adaptive master action control**: the master action bar dynamically switches between "⚡ Upgrade Both Sides", "Upgrade Remote Gateway", and "Restart to Update" based on combined dual-end state, with automatic pre-fetching of remote update info upon opening the About pane.

## v0.2.34 (2026-10-10)

### 中文

- 桌面端支持自定义服务地址（Custom URL）直连模式：
  - **Custom URL 直连通道**：桌面端新增直连已运行 SuperIU 服务的能力，无需配置 SSH 隧道，可直接通过局域网、内网穿透或 Docker 地址（HTTP/HTTPS）连接；
  - **自动注入配对凭据**：当远端开启 Web 配对鉴权时，支持输入可选配对密钥/Token，直连启动时自动向会话 Cookie 注入 `pairing_key`，免去浏览器跳转阻断；
  - **设置面板与首次向导集成**：设置页「远程 VPS 连接」面板新增「SSH 隧道部署」与「自定义服务地址」分段切换，支持持久化为默认启动连接，且在首次启动向导中新增直连卡片与表单。

### English

- Desktop client support for Custom URL direct connection mode:
  - **Custom URL direct connection channel**: the desktop client can now directly connect to an already-running SuperIU service without configuring an SSH tunnel, supporting LAN addresses, tunnels, and Docker containers (HTTP/HTTPS);
  - **Automatic pairing credential injection**: supports supplying an optional pairing key/token when the remote service enforces web pairing authentication, automatically injecting the `pairing_key` cookie into the Electron session upon launch;
  - **Settings pane and first-run onboarding wizard integration**: the "Remote VPS" settings pane features a segmented control switching between SSH Tunnel and Custom URL with a "save as default" toggle, accompanied by a dedicated card in the first-run onboarding wizard.

## v0.2.33 (2026-10-10)

### 中文

- 远端守护进程持久化与双重监听（Dual-Listen）：
  - **自动配置持久化系统守护进程**：Desktop 远程连接 SSH 时，自动探测远端 `systemd --user` 支持，自动调用 `loginctl enable-linger` 开启用户会话持久化（确保断开 SSH 后不被系统回收杀死），并在 `~/.config/systemd/user/superiu-server.service` 自动写入用户服务单元与开机自启配置；非 systemd 环境平滑降级为 `setsid nohup` 进程；
  - **双重监听（Dual-Listen）架构**：服务端支持同时监听 Unix domain socket（供 Desktop 经 SSH 隧道高速、零冲突接入，免配对认证）与 TCP 端口（如 `7345` / `3000`，绑定 `0.0.0.0`，受 Web 配对鉴权保护），使得 Desktop 不在线时，用户依然可以通过浏览器随时访问 Web 控制台；
  - **Desktop 状态提示增强**：连接进度步骤中详细展示 Unix domain socket 路径及 Web 控制台端口，方便多端协同。

### English

- Persistent remote daemon auto-provisioning and dual-listen web access:
  - **Automatic persistent system daemon configuration**: when connecting via SSH, Desktop automatically detects `systemd --user` availability, enables `loginctl enable-linger` (preventing session cleanup upon SSH disconnect), and generates a systemd user unit at `~/.config/systemd/user/superiu-server.service` with automatic restart and boot enablement; gracefully falls back to `setsid nohup` in non-systemd environments.
  - **Dual-listen server architecture**: `superiu-server` now simultaneously listens on a Unix domain socket (for Desktop SSH tunnel loopback traffic with zero port conflict and loopback trust) and a TCP port (such as `7345` / `3000` on `0.0.0.0`, protected by web pairing auth), allowing users to access the Web Console via browser even when Desktop is closed/offline.
  - **Enhanced connection status details**: connection progress displays both the active Unix domain socket path and the web console port for seamless multi-device coordination.

## v0.2.32 (2026-10-09)

### 中文

- 彻底禁止桌面端启动时触发 Web 配对全屏卡片：
  - **环境物理隔离**：明确 Web 控制台配对卡片仅服务于无头独立浏览器环境；在 SuperIU Desktop 桌面端环境（`window.superiuDesktop`）中，全面禁止弹出 `#connect-screen` 全屏遮罩；
  - **优雅降级与通道保持**：桌面端遇到远端 401 鉴权异常时，通过常规 Toast 提示用户检查 SSH 远程连接，绝不拦截并隐藏主界面（`.siu-app`），确保桌面端启动后永远保持可用，随时可访问设置或切换模式。

### English

- Completely forbid Desktop client from triggering the full-screen Web pairing screen on startup:
  - **Environment boundary enforcement**: clarified that the Web Console pairing screen is strictly for headless standalone web browser environments; on SuperIU Desktop (`window.superiuDesktop`), `#connect-screen` is permanently prohibited from popping up.
  - **Graceful degradation without hijacking**: when the desktop client encounters a 401 unauthorized status from a remote daemon, it reports a standard error toast directing the user to verify SSH remote settings, without hiding the primary app chrome (`.siu-app`), ensuring the desktop shell is always interactive and functional upon launch.

## v0.2.31 (2026-10-09)

### 中文

- 设置面板检查更新页支持展示远程 Gateway 版本与双端协同升级：
  - **双端节点看板**：在连接到远程 VPS Gateway 或纯 Web 控制台时，关于更新卡片自动扩展为双端状态看板，同时展示本地客户端与远端网关守护进程的当前版本与最新可用版本；
  - **一键升级双端**：当双端均有新版本时，提供高亮的「⚡ 一键升级双端」主按钮，采用「远端增量升级先行重载 + 本地差分下载收尾重启」的平滑时序，杜绝过早断开隧道导致的盲区；亦支持单独升级远端或本地；
  - **任务防打断与平滑重连**：远端服务升级内置空闲保护（正在执行 Agent 任务时拒绝打断），重启后前端通过长连接重试平滑过渡并自动刷新版本；
  - **服务升级接口与守护进程调度**：服务端新增 `/api/update` GET（探活最新版本）与 POST（执行换装与热重载）鉴权接口，支持忽略回退限制强制应用最新版本；桌面端同步支持通过 SSH 管道或 API 调用远端自更新。

### English

- Support remote Gateway version display and dual-node one-click upgrade in Settings:
  - **Dual-node update matrix**: when connected to a remote VPS Gateway or running in the web console, the About update card dynamically expands to display both local desktop client and remote daemon versions and update availability.
  - **One-click upgrade both sides**: when updates are available on both sides, a prominent "⚡ Upgrade Both Sides" button coordinates sequential upgrade (remote delta patch & drain reload first, local differential download and restart last), avoiding connection loss during update; also supports upgrading remote or local individually.
  - **Turn safety & seamless reconnect**: remote self-update respects agent turn execution (blocks restart while a turn is active); client heartbeats smoothly handle the brief daemon respawn and refresh versions automatically.
  - **Update API & daemon orchestration**: added `/api/update` GET (release availability probe) and POST (drain & respawn) endpoints on the server with idle safety guards; desktop shell exposes direct remote upgrade fallback via SSH or API.

## v0.2.30 (2026-10-09)

### 中文

- 修复 Desktop 桌面端在 SSH Remote 模式下被误锁入 Web 控制台配对卡片的问题：
  - **Unix 域套接字信任豁免**：Desktop 远程连接默认通过 SSH 隧道转发至远端 VPS 的 Unix 域套接字 (`AF_UNIX`)。Node.js 原生将此类本地连接的 `remoteAddress` 置为 `undefined`，修复了鉴权中间件将其误判为外网连接而返回 401 Unauthorized 的漏洞，完全信任 SSH 隧道本地 IPC 对端；
  - **Desktop 配对屏防死锁与退出通道**：在桌面端环境中，配对界面不再隐藏应用主界面（`.siu-app`），右上角提供关闭按钮，支持按 `Esc` 键或点击毛玻璃背景直接关闭；
  - **SSH Remote 与本地模式快捷切换**：配对卡片底部新增「使用 SSH 远程连接」（直达 SSH 远程设置面板）及「返回本地单机模式」快捷按钮，确保桌面端永远可以自由返回常规 SSH 远程或本地流程。

### English

- Fix Desktop client being locked out by the Web Console pairing screen in SSH Remote mode:
  - **Unix domain socket loopback trust exemption**: Desktop remote mode forwards over SSH tunnels to a Unix domain socket (`AF_UNIX`) on the VPS by default. Node.js natively reports `req.socket.remoteAddress` as `undefined` for local socket connections; resolved the regression where the auth middleware mistook it for an external peer and returned 401 Unauthorized, ensuring SSH-tunneled local IPC is fully trusted.
  - **Desktop anti-deadlock & dismissibility**: on Desktop, the pairing screen no longer hides the main application layout (`.siu-app`), adds a close button in the top right, and can be dismissed via `Esc` key or clicking the backdrop.
  - **Quick exit to SSH Remote & Local mode**: added "Use SSH Remote" (navigates directly to SSH remote settings) and "Return to local mode" action buttons on the pairing card, ensuring desktop users always have an unobstructed exit to standard SSH remote or local modes.

## v0.2.29 (2026-10-09)

### 中文

- 优化服务商模型列表获取与批量选择交互体验：
  - **默认不再全选**：在设置中点击「获取模型」从服务商拉取模型列表时，新拉取的模型默认不再全部自动勾选，避免将大量未筛选模型直接灌入输入框模型选择器中；已配置过的已有模型保持原有启用状态不变；
  - **一键全选与取消全选**：在模型列表标题栏右侧新增「全选」与「取消全选」按钮，支持一键批量启用或停用模型；在输入关键词过滤搜索时，仅对当前筛选可见的模型生效；按钮根据当前选中状态动态禁用与激活；
  - **多端与双语适配**：中英文界面完整本地化，通过全套代码与多语言守卫校验。

### English

- Improve model fetching and batch selection workflow in provider settings:
  - **No longer auto-select all on fetch**: fetching models from a provider API now defaults newly discovered models to disabled (`enabled: false`) instead of checking all of them, preventing unwanted models from flooding the composer picker; existing configured models retain their current state.
  - **One-click Select All and Deselect All**: added "Select all" and "Deselect all" buttons beside the Models header, allowing batch enabling or disabling with a single click; respects the current search filter when searching; dynamically reflects enabled/disabled state based on current selection.
  - **Bilingual & localization parity**: fully localized in both Chinese and English, passing all strict dictionary and parity guards.

## v0.2.28 (2026-10-09)

### 中文

- 在桌面端主界面右上角标题栏新增更新提示胶囊与主动重启按钮（参考 OpenCode Desktop）：
  - **位置与布局**：位于标题栏右侧操作区（`siu-titlebar-actions`），紧邻「更多」按钮左侧，携带 `no-drag` 属性可穿透 macOS 窗口拖拽直接点击；
  - **下载中胶囊态**：在后台下载更新时展示低干扰的紧凑蓝色胶囊态，配有旋转环形进度指示器及整数字符串百分比（如 `更新中 2%`），悬浮展示下载进度详情；
  - **就绪态主动重启**：在差分或全量更新下载校验完成（`ready`）后，亮起翡翠绿/青色微光高亮胶囊按钮「重启更新」，带状态绿点与刷新图标；点击后可直接触发换装并平滑重启客户端；
  - **多端与双语适配**：仅在 Electron 桌面端展示，纯网页环境自动隐藏；小屏下自动折叠为紧凑图标；完全覆盖中英双语国际化词条并通过所有代码守卫校验。

### English

- Add titlebar update capsule and proactive restart button for the desktop app (referencing OpenCode Desktop):
  - **Placement**: located in the titlebar actions area (`siu-titlebar-actions`) immediately to the left of the "More" button, with `no-drag` to enable click interaction through the macOS draggable window region.
  - **Downloading state**: displays a gentle, low-distraction blue pill during background download, featuring a spinning ring progress indicator and integer percentage (e.g. `Updating 2%`), with detailed progress tooltip on hover.
  - **Ready state restart action**: glows into an emerald/cyan accent pill button labeled "Restart to Update" with a green status dot and refresh icon once the update is staged and verified (`ready`); clicking proactively triggers bundle swap and restarts the client.
  - **Responsive & bilingual**: active only in the Electron desktop shell (hidden in plain web browsers); collapses text gracefully on narrow windows; fully localized in both Chinese and English with all guards passing.

## v0.2.27 (2026-10-09)

### 中文

- 修复设置弹窗中「设备配对」菜单项在本地/桌面端运行环境下未展示的问题：
  - 此前配对管理端点 `/api/pairing` 仅在 `isEnabled()` 为真时开放，导致本地回环模式（`127.0.0.1` 且尚未生成密钥时）返回 404，前端探查判定不支持而将该菜单项隐藏；
  - 放开本地回环对端对 `/api/pairing` 的常驻管理能力，允许桌面端或本地 Web 随时进入设置查看授权设备列表并为手机等其他设备生成配对链接；
  - 移除设置导航项初始的 `hidden` 属性，确保「设备配对」作为常规设置面板稳定展现。

### English

- Fix the "Pairing" menu item in the Settings dialog not displaying under local/desktop environments:
  - Previously, `/api/pairing` management was guarded behind `isEnabled()`, causing it to return 404 in local loopback mode when no keys had yet been minted, which led the frontend capability probe to hide the tab.
  - Enabled pairing management for trusted loopback peers regardless of initial key presence, allowing local desktop and web users to always view authorized devices and mint pairing links for other clients.
  - Removed the initial `hidden` attribute from the settings navigation item to guarantee the Pairing panel renders reliably alongside standard settings panes.

## v0.2.26 (2026-10-09)

### 中文

- 新增 Web 控制台的**配对（Pairing）认证**与弱网容错层，取代此前「控制台无认证」的状态：
  - **自动启用**：默认 AUTO——当绑定地址非回环（如 `0.0.0.0`），或工作区 `.superiu/pairing.json` 已存在密钥/配对码时自动要求认证；回环绑定且无密钥时保持开放，`pnpm ui`、桌面端本地模式与 SSH 隧道访问行为不变。可用 `SUPERIU_WEB_AUTH=1/0` 强制开/关。
  - **一次性配对链接**：`superiu-server pair` 生成 5 分钟有效、仅可使用一次的链接（`/auth/connect/:code`）；打开后换取长期密钥并写入 `HttpOnly` Cookie。密钥有效期**滑动**，默认最后一次使用后 30 天（`SUPERIU_PAIRING_TTL_DAYS` 可调）。
  - **安全存储与管理**：密钥仅以 SHA-256 摘要保存在 `.superiu/pairing.json`（0600，原子写入），可用 id 列表/吊销（`superiu-server pair --list|--revoke`）；控制台设置第 8 面板提供图形化设备管理与为其他设备发码功能。
  - **弱网容错**：SPA 新增 `api()` 重试容错层、离线横幅与状态机，网络波动时保留界面既有数据（stale-not-blank）不清空；流式生成中断优雅提示。
  - **信任与防护**：回环对端（含 SSH 隧道）免认证，`X-Forwarded-For` 不被信任；失败尝试每 IP 每分钟 20 次后返回 429；401 仅在导航请求发送 `WWW-Authenticate`，避免 fetch 触发浏览器原生凭据弹窗。

### English

- Add **pairing authentication** and network resilience to the web console, replacing the previous "no authentication" state:
  - **Automatic**: AUTO by default — auth turns on when the bind address is not loopback (e.g. `0.0.0.0`), or when a key/code already exists in the workspace's `.superiu/pairing.json`; a loopback bind with no keys stays open, so `pnpm ui`, the desktop's local mode and SSH-tunnel access are unchanged. Force it with `SUPERIU_WEB_AUTH=1/0`.
  - **One-time links**: `superiu-server pair` prints a link that works once and expires in 5 minutes (`/auth/connect/:code`); opening it exchanges the code for a long-lived key stored in an `HttpOnly` cookie. Key expiry **slides** — 30 days after the most recent use by default (`SUPERIU_PAIRING_TTL_DAYS`).
  - **Safe storage & management**: keys are kept SHA-256-hashed in `.superiu/pairing.json` (0600, atomic writes) and can be listed/revoked by id (`superiu-server pair --list|--revoke`); Settings panel 8 offers graphical device management and pairing code minting for other devices.
  - **Network resilience**: added `api()` wrapper with retry/timeout, top offline banner with online/degraded/offline state machine, preserving existing data on network degradation (stale-not-blank); graceful interruption recovery for stream responses.
  - **Trust and hardening**: loopback peers (including SSH tunnels) are exempt and `X-Forwarded-For` is never trusted; failed attempts are throttled to 429 after 20 per IP per minute; a 401 carries `WWW-Authenticate` only for navigations, so fetches never trigger the browser's native credential prompt.

## v0.2.25 (2026-10-09)

### 中文

- 修复桌面端自动更新下载进度百分比出现过多小数位的问题：
  - 增量差分更新（BlockMap）组装时直接向回调传入 `(written / filesize) * 100` 浮点数，导致界面显示如 `正在下载更新: 2.1558355398268527%` 等冗长小数位；
  - 在桌面端更新调度器适配层（`acquireZip.onProgress`）中将进度取整为整数百分比，并在整数步进变化时才分发状态，避免无谓的 IPC 广播与界面重绘；
  - 在界面设置「关于」更新状态渲染器中增加百分比取整与边界收拢保护，双重防御确保进度显示简洁规整。

### English

- Fix desktop update download progress displaying excessive decimal places:
  - Differential blockmap assembly previously forwarded raw `(written / filesize) * 100` floats to `onProgress`, rendering unwieldy fractions in the UI (e.g. `Downloading update: 2.1558355398268527%`).
  - Rounded progress percentages to whole integers in the desktop updater adapter (`acquireZip.onProgress`) and deduplicated state notifications across integer percentage steps to eliminate redundant IPC traffic and re-renders.
  - Added integer rounding and boundary clamping in the UI settings "About" update status renderer as defense-in-depth, guaranteeing clean whole-number progress display.

## v0.2.24 (2026-10-09)

### 中文

- 彻底移除服务商（Provider）的硬编码预置与强制默认启用：
  - **零预置与默认未激活**：新安装或未配置时，`providers` 初始为空列表（`[]`），`activeProviderId` 初始为空（`''`），不再默认塞入 5 个预置服务商槽位，也不再无条件亮绿灯默认激活 OpenAI。未配置服务商时界面如实显示「未配置服务商」。
  - **预设退化为新建模板**：点击「添加服务商」提供快速模板菜单（包括 OpenAI、DeepSeek、Google Gemini、Anthropic、Ollama、OpenRouter 及自定义服务商），一键带入 Base URL 与申请链接，不再预先污染配置文件。
  - **自由管理服务商**：允许关闭生效的服务商（支持 0 个服务商处于激活状态）；解除至少保留 1 个服务商的限制，支持删除至空列表，并在列表为空时提供友好的空状态界面。
  - **清理旧版本遗留槽位**：自动识别并清理历史版本写入的无 Key、无模型的空预设槽位，避免旧配置持续默认激活 OpenAI。

### English

- Completely remove hardcoded preset providers and mandatory default enablement:
  - **Zero presets and default unactivated**: on fresh installs or unconfigured states, `providers` starts as an empty array (`[]`) and `activeProviderId` starts empty (`''`). The app no longer injects 5 dummy provider slots or forces OpenAI to appear enabled with a green dot. Unconfigured states honestly display "No providers configured".
  - **Presets demoted to creation templates**: clicking "Add provider" presents a quick template menu (including OpenAI, DeepSeek, Google Gemini, Anthropic, Ollama, OpenRouter, and Custom) to easily pre-fill Base URLs and help links, without polluting user config files upfront.
  - **Full provider management**: allows toggling off the active provider (supporting 0 active providers); removes the constraint requiring at least 1 provider, allowing deletion down to an empty list with clear empty-state messaging.
  - **Clean up legacy phantom slots**: automatically identifies and prunes unused preset slots (no API key, no models) seeded by older builds, preventing them from default-activating OpenAI.

## v0.2.23 (2026-10-08)

### 中文

- 修复桌面端远程 SSH / 网关连接状态页面（`gatewayStatusHtml`）在窗口中未垂直居中的问题：
  - 此前容器仅配置了水平居中与固定顶部内边距（`padding-top: 46px`），在 1280×860 及高分辨率屏幕大窗口下底部大量留白、视觉严重偏上；
  - 将 `body` 设为 `min-height: 100vh; display: flex; flex-direction: column; align-items: center;`，并通过 `.wrap { margin: auto; }` 实现视口上下边距自动均分的垂直+水平双向居中；
  - 依赖 flexbox `margin: auto` 溢出自适应机制：在小窗口或展开详细步骤日志超出视口时，margin 安全折叠为 0，防止顶部被负向滚动裁切，同时保留顶部对 macOS 38px 拖拽区（交通灯）的避让安全间距。

### English

- Fix desktop remote SSH / gateway connection status view (`gatewayStatusHtml`) not being centered in the window:
  - Previously, the container only had horizontal centering with a fixed top offset (`padding-top: 46px`), leaving large empty space at the bottom in the 1280x860 default window and high-resolution displays.
  - Set `body` to `min-height: 100vh; display: flex; flex-direction: column; align-items: center;` and applied `margin: auto` to `.wrap` for balanced vertical and horizontal centering.
  - Leveraged flexbox `margin: auto` overflow behavior: when window height is small or step details expand beyond the viewport, margin safely collapses to 0 to prevent negative-scroll top clipping, while preserving macOS 38px titlebar drag region and traffic lights clearance.

## v0.2.22 (2026-10-08)

### 中文

- 修复「没有配置任何模型时，界面仍显示模型」：全新安装会把出厂预设目录写进每个服务商，并把 `gpt-4o` 当作当前模型显示（composer 模型药丸、⌘J 模型下拉），保存时还会一并写进 `ui-settings.json`——这些型号用户从未添加过。
  - **「已配置」只认用户自己的配置文件与环境变量**：`modelName`/`reviewModelName` 不再回退出厂默认值，新建服务商的模型列表从**空**开始，接口的 `modelChoices` 只包含用户自己的模型（各服务商 `models[]` 加两个模型名，去重）。
  - **清空旧版本写进去的出厂目录**：加载时，模型列表若与出厂目录**逐字节相同**（含历史版本列表）即视为 app 写入而非用户选择，清空为 `[]`；同一文件里 app 写的出厂默认模型名（`gpt-4o`/`gpt-4o-mini`）在没有任何服务商仍列出它时一并清空。用户增删改过（哪怕只差一个 id 或顺序）的列表**一字不动**；只读加载**不写盘**，清理在下一次保存时落盘。
  - **空态如实显示**：模型药丸、工具/审查模型 chip、⌘J 模型下拉显示「未配置模型」；模型弹层对未配置的服务商提示「{服务商} 尚未添加模型」，不再谎称「没有匹配的模型」；服务商没有模型时隐藏模型搜索框。设置面板「添加模型」输入框仍以出厂型号作为自动补全候选（仅建议，不算已配置）。
  - **取舍**：出厂目录不再预填，选择模型需点「获取模型」或手动输入；core 仍以 `gpt-4o` 兜底运行（服务端启动横幅标注 `(default)`），只是界面不再把它冒充成用户的选择。

### English

- Fix "the UI shows a model even though nothing is configured": a fresh install seeded every provider with the shipped preset catalog, presented `gpt-4o` as the model in force (the composer's model pill and the ⌘J model selector), and persisted all of it into `ui-settings.json` — model ids the user never added.
  - **"Configured" now means present in the user's own settings file or environment**: `modelName`/`reviewModelName` no longer fall back to the shipped defaults, a provider starts with an **empty** model list, and the API's `modelChoices` carries only the user's own models (each provider's `models[]` plus the two model names, de-duplicated).
  - **Stored shipped catalogs are cleared**: on load, a model list **byte-identical** to a catalog this app shipped (including the older lists) is treated as written by the app rather than chosen by the user and cleared to `[]`; the shipped default model names beside it (`gpt-4o`/`gpt-4o-mini`) are cleared too when no provider still lists them. A list the user edited — even by one id or a reorder — is left untouched, and merely reading settings **never writes to disk**; the clearing lands on the next save.
  - **Honest empty states**: the model pill, the tool/review-model chip and the ⌘J model selector read "No model configured"; the model popover tells an unconfigured provider's story ("{provider} has no models yet") instead of claiming "no matching model", and the model search box is hidden for a provider with no models. The settings pane's add-model field still offers the shipped ids as autocomplete — suggestions only, never counted as configured.
  - **Trade-off**: the preset catalog is no longer pre-filled, so picking a model requires **Fetch models** or typing an id; core still runs on its `gpt-4o` fallback (the server banner marks it `(default)`), it just stops presenting it as a choice the user made.

## v0.2.21 (2026-10-08)

### 中文

- 桌面端与无头服务端升级均支持**增量（差分）下载**：常规更新只传输变化的部分，不再每次拉取整个安装包。
- 桌面端（macOS）发布时在 zip 旁同时上传 `<zip>.blockmap`（64 KiB 固定分块 + 每块 sha256）；客户端把上一次下载的 zip 缓存为临时目录下的 `superiu-base.zip`，按块哈希比对后用 HTTP `Range` 只拉取缺失块并在本地拼装，随后仍走既有的 `ditto -x -k` 解压与 `replaceBundle` 原子换装，代码签名与 Gatekeeper 校验完全不变。映射缺失、缓存缺失、服务端不支持 `Range`（返回 200 而非 206）或拼装后 sha256 校验失败都会自动回退为全量下载。
- 无头服务端发布时在二进制旁同时上传 `<binary>.patch`（内容定义分块 + COPY/INSERT 指令，gzip 压缩，78 字节明文头部）；`superiu-server update` 与空闲自动更新会先以 78 字节 `Range` 请求读取补丁头部，只有本机二进制的 sha256 与补丁记录的源一致时才下载补丁并在本地重建，重建结果再经既有的二进制 `version` 自检与版本比较。来源不匹配、补丁损坏或任何其他失败都回退为全量下载。
- 增量下载是纯流量优化：任一环节不可用时，行为与升级前完全一致。

### English

- Both the desktop and the headless server can now upgrade **differentially**: a routine update transfers only what changed instead of the whole package.
- The macOS release publishes a `<zip>.blockmap` beside the zip (fixed 64 KiB chunks, one sha256 per chunk). The client caches the previously downloaded zip as `superiu-base.zip` in its temp directory, matches chunks by hash, fetches only the missing byte ranges with HTTP `Range`, and stitches them into the new archive locally — after which the existing `ditto -x -k` unpack and `replaceBundle` atomic swap run unchanged, so code signing and Gatekeeper verification are unaffected. A missing map, a missing cache, a server that ignores `Range` (200 instead of 206), or a failed post-assembly sha256 check all fall back to the full download.
- The server release publishes a `<binary>.patch` beside the binary (content-defined chunking with COPY/INSERT commands, gzip-compressed, 78-byte plaintext header). `superiu-server update` and the idle auto-update first read that header with a 78-byte `Range` request, download the patch only when the on-disk binary's sha256 matches the recorded source, rebuild locally, and then run the existing binary `version` self-check and version comparison. A source mismatch, a corrupt patch, or any other failure falls back to the full download.
- Differential transfer is a pure traffic optimization: whenever any part of it is unavailable, behaviour is identical to before.

## v0.2.20 (2026-10-08)

### 中文

- 远程连接新增 **Unix 域套接字传输**：`superiu-server` 支持 `--socket <path>`，在工作区内以 **`0600` 权限的 Unix 套接字**提供 SPA 与网关，不再占用回环 TCP 端口；桌面端用 OpenSSH 的 StreamLocalForward（`-L <localPort>:<remoteSocket>`）把本地端口转发到该套接字。
  - **传输方式能力协商**：连接时探测远端二进制是否广告 `--socket`，支持才走套接字，否则自动回退到原有端口模式；已运行的守护进程按其上报的传输方式采纳，不强制重启。
  - 升级守护进程后**重新探测**并以套接字方式启动新二进制——否则升级前探测到的「不支持套接字」结果会把新守护进程永久钉在端口模式。
  - 修复套接字模式下守护进程无法被采纳的问题：套接字守护进程上报 `port: 0`，此前仅凭端口判断存活会漏判，进而丢失已配对的 token。
- **SSH 连接复用**：所有远端命令与隧道复用同一个已认证的 OpenSSH ControlMaster 连接（`ControlMaster=auto` + `ControlPath` + `ControlPersist=10m`，控制套接字位于 `~/.superiu/run`，权限 `0700`）。首次认证后探测/安装/启动/隧道均为毫秒级，且不会再反复弹出密钥口令提示。Windows 上自动跳过（Win32-OpenSSH 不支持连接复用）。
- 新增 `GET /readyz` 就绪端点：桌面端在隧道建立后探测该端点（旧守护进程返回 404 时按就绪处理），确认守护进程真正可服务后再连接网关客户端。
- 连接状态页重构为原生竖向 7 步时间线，并改用应用自身的原生图标（内联 Base64），不再使用字母渐变方块。

### English

- Remote connections gain a **Unix domain socket transport**: `superiu-server` accepts `--socket <path>` and serves the SPA and gateway on a **`0600` socket inside the workspace** instead of a loopback TCP port; the desktop forwards a local port to that socket over OpenSSH StreamLocalForward (`-L <localPort>:<remoteSocket>`).
  - **Capability-negotiated transport**: connect probes whether the remote binary advertises `--socket` and uses the socket only when it does, otherwise falling back to the original port mode; an already-running daemon is adopted with whatever transport it reports, without a forced restart.
  - After a daemon upgrade the probe is **refreshed** and the new binary is started on a socket — otherwise the stale pre-upgrade "no socket support" result would pin the new daemon to port mode forever.
  - Fix a socket-mode daemon not being adopted: it reports `port: 0`, so a port-only liveness check missed it and lost the already-paired token.
- **SSH connection reuse**: every remote command and the tunnel share one authenticated OpenSSH ControlMaster connection (`ControlMaster=auto` + `ControlPath` + `ControlPersist=10m`, control sockets under `~/.superiu/run` at `0700`). After the first authentication, probe/install/start/tunnel are millisecond-fast and the key passphrase is never re-prompted. Skipped on Windows (Win32-OpenSSH does not support multiplexing).
- New `GET /readyz` readiness endpoint: after the tunnel is up the desktop probes it (a 404 from an older daemon is treated as ready) and only then connects the gateway client.
- The connection status page is rebuilt as a native vertical 7-step timeline using the app's own native icon (inline base64) instead of the lettered gradient tile.

## v0.2.19 (2026-10-08)

### 中文

- 修复远程模式下连接状态徽标（标题栏 `● arm · 42ms`）始终不显示的问题：远程模式加载的是**守护进程自带的 SPA**，而非本地桌面包，因此一个早于徽标特性安装的 VPS 守护进程会一直提供旧版控制台。
  - **根因**：`RemoteConnectionManager.connect()` 此前只在守护进程**未安装**、或调用方**显式钉住版本**时才安装/升级；没有任何东西钉住版本，所以已安装的守护进程永远不会升级（实测用户的 VPS 守护进程为 `0.1.0`，安装于两天前）。
  - **修复**：连接时以桌面应用自身版本为「目标守护进程版本」（`daemonTargetVersion`）。已安装的守护进程**低于**该版本即升级；下载**钉住该精确版本**，因此升级后再次连接会判定相等、不再重复下载（收敛，不会陷入升级循环）。版本不可解析时视为未知、保持不动，不做盲目重下。
  - **机会式升级**：staleness 升级可以失败（开发构建的版本没有对应 release 会 404），此时保留仍可用的旧守护进程并继续连接；只有「守护进程缺失」与「显式钉版本」这两种没有退路的情况才会让连接失败。
- 从 `updater.ts` 抽出纯 semver 模块 `packages/desktop/src/semver.ts`（`parseVersion` / `semverGt`），使 `remote/manager.ts` 能在不引入 `electron` 的前提下比较版本；`updater.ts` 继续导出这两个符号，对外契约不变。

### English

- Fix the connection status badge (titlebar `● arm · 42ms`) never appearing in remote mode: remote mode loads the **daemon's own bundled SPA**, not the local desktop bundle, so a VPS daemon installed before the badge feature kept serving an old console.
  - **Root cause**: `RemoteConnectionManager.connect()` only installed/upgraded the daemon when it was **absent** or the caller **explicitly pinned a version**. Nothing pinned one, so an already-installed daemon was never upgraded (measured: the user's VPS daemon was `0.1.0`, installed two days earlier).
  - **Fix**: connect now targets the desktop app's own version (`daemonTargetVersion`). An installed daemon **older** than that is upgraded, with the download **pinned to that exact version**, so the next connect compares equal and does not re-download (convergence, not an upgrade loop). An unparseable installed version is treated as unknown and left alone rather than blindly re-downloaded.
  - **Opportunistic upgrade**: a staleness upgrade may fail (a dev build's version has no release and 404s); the still-working old daemon is then kept and the connect continues. Only an absent daemon and an explicit pin — neither of which has a fallback — fail the connect.
- Extract a pure semver module `packages/desktop/src/semver.ts` (`parseVersion` / `semverGt`) from `updater.ts` so `remote/manager.ts` can compare versions without pulling in `electron`; `updater.ts` still re-exports both symbols, so its public contract is unchanged.

## v0.2.18 (2026-10-08)

### 中文

- 统一所有 `package.json` 的版本号（根目录与 `packages/{ui,core,cli,protocol,desktop}`）为 `0.2.18`，修复此前只有 `packages/desktop` 在 bump、其余五个长期停留在 `0.1.0` 的版本漂移。
  - **根目录 `package.json` 是滚动渠道服务端二进制的版本来源**：`release.yml` 在 tag 构建时把 tag 烘焙进二进制，但推送 `master` 的滚动构建传空 `SUPERIU_VERSION`，于是回落到根 `package.json`。根版本长期为 `0.1.0`，导致**每个滚动渠道的 `superiu-server` 二进制都自称 `0.1.0`**（实测：`releases/download/latest/superiu-server-linux-arm64` 内嵌 `0.1.0`，而 `v0.2.17` 的内嵌 `0.2.17`）。
  - `packages/ui/package.json` 同样在运行时生效：`node dist/daemon.js` 的 `resolveVersion()` 向上查找 `package.json` 时先命中 `packages/ui/package.json`，因此它也必须与根版本一致。
- `superiu-server` 的版本解析加固：`normalizeTag()` 现在要求剥离前导 `v` 后的结果必须能被 semver 解析，否则返回 `undefined`。滚动渠道的 tag 是字面量 `latest`（并非版本号），此前会被原样返回并打印成 `latest: latest`；现在被正确判定为「无版本」。同时修正了 `fetchLatestVersion()` 上方「该端点永远 404」的过时注释——存在稳定 tag 后它不再 404，守护进程的升级解析只认稳定发布，不追预发布渠道。
- 新增 `scripts/check-version-parity.mjs` 版本一致性守卫并接入 `pnpm test`：断言六个 manifest 版本完全一致、且根与 desktop 一致（根即滚动服务端二进制的回落来源）。该守卫经过植入缺陷差分验证——把根版本改回 `0.1.0`（线上真实发生过的状态）会使其 FAIL 并点名 `package.json`。

### English

- Unify every `package.json` version (root plus `packages/{ui,core,cli,protocol,desktop}`) at `0.2.18`, fixing a version drift where only `packages/desktop` was ever bumped and the other five sat at `0.1.0`.
  - **The root `package.json` is the version source for rolling-channel server binaries**: `release.yml` bakes the tag on tagged builds, but a `master` push passes an empty `SUPERIU_VERSION` and falls back to the root manifest. The root stayed at `0.1.0`, so **every rolling-channel `superiu-server` binary reported itself as `0.1.0`** (measured: `releases/download/latest/superiu-server-linux-arm64` embeds `0.1.0`, while `v0.2.17` embeds `0.2.17`).
  - `packages/ui/package.json` is likewise load-bearing at runtime: the `resolveVersion()` walk from `node dist/daemon.js` hits `packages/ui/package.json` before the root, so it must agree too.
- Harden the `superiu-server` version resolution: `normalizeTag()` now requires the value (after stripping a leading `v`) to parse as semver, returning `undefined` otherwise. The rolling channel's tag is the literal `latest` — not a version — which was previously returned verbatim and printed as `latest: latest`; it is now correctly treated as "no version". The stale "that endpoint 404s forever" comment above `fetchLatestVersion()` is corrected: it stops 404ing once a stable tag exists, and the daemon resolves upgrades from stable releases only rather than chasing a prerelease channel.
- Add `scripts/check-version-parity.mjs`, wired into `pnpm test`: it asserts all six manifests agree and that root matches desktop (root being the rolling server-binary fallback). The guard was validated by injecting the defect — setting root back to `0.1.0` (the state that actually shipped) makes it FAIL and name `package.json`.

## v0.2.17 (2026-10-08)

### 中文

- VPS 守护进程新增 `superiu-server update` 命令：`--check` 仅报告当前版本与最新版本，`--force` 强制升级，`--version <v>` 可指定版本；执行时会下载适配当前主机架构的最新 Linux 二进制，原子替换后重启守护进程。
- `superiu-server status` 现在会输出 `workspace` 字段，安装脚本可在任意工作目录下定位守护进程（此前升级后始终无法重启）。
- `/api/status` 与 WebSocket 注册应答现在携带真实的服务器构建版本。
- VPS 守护进程新增**可选**的空闲自动更新：`--auto-update-idle`（或 `SUPERIU_AUTO_UPDATE_IDLE=1`，`1`/`true`/`yes` 为真值）默认关闭，间隔由 `--auto-update-interval-hours <n>`（或 `SUPERIU_AUTO_UPDATE_INTERVAL_HOURS`）控制，默认 `6` 小时且必须大于 `0`；首次检查在启动满一个间隔后才执行。仅在存在更新版本且守护进程真正空闲（无进行中的回合、无等待人工审批的回合、无网关在途回合）时升级，否则记录推迟并在下一轮重试；失败的版本写入 `<workspace>/.superiu/update-state.json` 并在 24 小时内不再重试，以避免崩溃循环。
- 空闲自动更新触发时先下载并校验新二进制（此期间服务器正常提供服务），仅在最后原子替换与重启的毫秒级窗口内进入 draining 状态：`POST /api/chat` 返回 HTTP 503，WebSocket 网关拒绝新的提示回合，进行中的回合可正常结束。
- 空闲自动更新遵循 `--release-base <url>` / `SUPERIU_RELEASE_BASE`：该基址会写入守护进程状态文件，并在自重启时通过 `--release-base` 原样重放，避免私有镜像被静默回退到默认 GitHub 发布渠道。
- 新增显式关闭空闲自动更新：`--no-auto-update-idle`（或 `SUPERIU_AUTO_UPDATE_IDLE=0|false|no`）。三态优先级为「命令行 > 环境变量 > 持久化」，显式关闭会同时清除状态文件中已持久化的 `autoUpdateIdle`/`autoUpdateIntervalHours`，因此之后不带旗标重启也不会重新开启（注意：`SUPERIU_AUTO_UPDATE_IDLE=0` 同样会抹掉持久化值，之后移除该变量将保持关闭，直到重新开启）；同时给出 `--auto-update-idle` 与 `--no-auto-update-idle` 视为用法错误。桌面端远程连接向导新增「空闲时自动更新」开关（默认关闭），关闭时会显式下发否定旗标。

### English

- The VPS daemon gains a `superiu-server update` command: `--check` only reports current vs. latest, `--force` upgrades regardless, and `--version <v>` pins a version; it downloads the latest released Linux binary for the host architecture, swaps it atomically, and restarts the daemon.
- `superiu-server status` now reports `workspace`, and the installer can find a daemon regardless of the working directory (previously it always failed to restart the upgraded daemon).
- `/api/status` and the WebSocket registration ack now carry the real server build version.
- The VPS daemon gains an **opt-in** idle auto-update: `--auto-update-idle` (or `SUPERIU_AUTO_UPDATE_IDLE=1`; `1`/`true`/`yes` are truthy) is off by default, and the interval is `--auto-update-interval-hours <n>` (or `SUPERIU_AUTO_UPDATE_INTERVAL_HOURS`), default `6`, must be `> 0`, with the first check one full interval after boot. It upgrades only when a newer version exists and the daemon is genuinely idle (no turn running, none waiting on a human approval, no gateway turn in flight), otherwise it logs a deferral and retries next tick; a failed version is recorded in `<workspace>/.superiu/update-state.json` and not retried for 24 hours to guard against crash loops.
- An idle auto-update tick downloads and verifies the new binary first (the server keeps serving normally throughout); only the final atomic swap and restart — a millisecond-scale window — drains the server, where `POST /api/chat` returns HTTP 503 and the WebSocket gateway refuses new prompt turns while an in-flight turn is allowed to finish.
- Idle auto-update honours `--release-base <url>` / `SUPERIU_RELEASE_BASE`: the base is written into the daemon state file and replayed verbatim as `--release-base` on the self-restart, so a private mirror never silently falls back to the default GitHub release channel.
- Idle auto-update can now be turned off explicitly with `--no-auto-update-idle` (or `SUPERIU_AUTO_UPDATE_IDLE=0|false|no`). The tri-state precedence is CLI > environment > persisted, and an explicit off also clears the persisted `autoUpdateIdle`/`autoUpdateIntervalHours` from the state file, so a later flagless restart cannot resurrect the feature (note that `SUPERIU_AUTO_UPDATE_IDLE=0` erases the persisted value too, so removing the variable afterwards leaves it off until enabled again); passing `--auto-update-idle` together with `--no-auto-update-idle` is a usage error. The desktop remote-connection wizard gains an "Update automatically when idle" switch (off by default) that sends the negative flag when switched off.

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
