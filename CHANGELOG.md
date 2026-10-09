# Changelog | 更新日志

All notable changes to SuperIU are documented here. Every release section must carry both Chinese and English notes (`### 中文` + `### English`). The release workflow extracts the matching section as the GitHub Release body — a missing or non-bilingual section fails the release.

SuperIU 的重要变更均记录于此。每个版本小节必须同时包含中文与英文说明（`### 中文` + `### English`）。发布流水线会提取对应小节作为 GitHub Release 正文——小节缺失或非双语将直接导致发布失败。

## Unreleased | 未发布

### 中文

- 暂无新变更；滚动 `latest` 渠道当前分发最近一个标签版本的内容。

### English

- No new changes yet; the rolling `latest` channel currently ships the most recent tagged release.

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
