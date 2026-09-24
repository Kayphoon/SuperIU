# Shells Guide

SuperIU is one engine with swappable presentation layers. The engine (`@agent/core`) owns the session, the loop, tool execution, and the approval policy; each shell is a client of it. Behaviour is therefore the same everywhere — only the surface differs.

This guide covers day-to-day use of each shell. For how the engine works internally, see [agent-loop-and-context-architecture.md](agent-loop-and-context-architecture.md).

| Shell | Package | Launch | Status |
| --- | --- | --- | --- |
| Terminal | `@agent/cli` | `pnpm cli` | Available |
| Web console | `@agent/ui` | `pnpm ui` | Available |
| macOS desktop | `@agent/desktop` | `pnpm desktop` | Available (requires a graphical session) |

All shells require a build and a configured `.env` first:

```bash
pnpm install
pnpm build
cp .env.example .env    # then fill in your credentials
```

---

## Interface language

Every shell ships **Chinese by default**; English is a first-class alternative, switchable at runtime.

| Shell | How to switch | Where it is stored |
| --- | --- | --- |
| Web console / desktop | Settings dialog (⌘,) → **界面语言 / Interface Language** | `.myagent/ui-settings.json` → `language` |
| macOS desktop | same control; the native menu bar rebuilds immediately | same file |
| Terminal | `SUPERIU_LANGUAGE=zh\|en pnpm cli` | read-only — the CLI never writes the settings file |

Resolution order is the same everywhere: an explicit `SUPERIU_LANGUAGE` environment variable, then the `language` field in `.myagent/ui-settings.json`, then `zh`. A value the build cannot render is ignored rather than honored, so an older shell reading a newer settings file degrades to the default instead of showing a half-translated UI.

The web console also mirrors the choice into `localStorage` so the first paint after a reload is already in the right language, with no English flash while `/api/settings` is in flight. The settings file remains authoritative — it is what the dialog edits and what the desktop shell reads at launch to build its menu bar.

Two things stay English on purpose, because translating them would break behaviour rather than improve it:

- The **operational posture** body in the secondary menu. That text is injected verbatim into the system prompt (`# OPERATIONAL POSTURE`), so the drawer shows the model's actual instructions; a translated copy would describe something the model never received. The posture *badge* itself is localized.
- Machine-readable values — status ids (`idle`, `running`, `tool_calling`), model names, session ids, JSONL paths, and the `/status` field labels — are data, not prose.

The desktop native menu is a main-process surface with its own small label table (`packages/desktop/src/menu.ts`); the browser dictionary (`packages/ui/public/i18n.js`) is not reachable from the packaged main process. The terminal has its own table (`packages/cli/src/language.ts`) for the same reason. The three tables deliberately share key *names* for shared concepts so the shells cannot drift semantically.

---

## Terminal shell — `pnpm cli`

```bash
pnpm cli
```

An interactive REPL. On start it prints the resolved configuration so you can confirm what you are actually talking to:

```
=== SuperIU Autonomous Agent CLI ===
Memory directory: /path/to/workspace/.myagent
Main model: gpt-4o
Review model: gpt-4o-mini
Session: 3dac40eb8d3865d3
Log: /path/to/workspace/.myagent/sessions/.../<timestamp>_3dac40eb8d3865d3.jsonl
Type /help for slash commands, or enter your task to begin.
```

Type a task and press Enter to run it. Type `/` for commands. Prompts are recorded in the prompt-history database before the turn starts, so an interrupted prompt is still recallable.

### Slash commands

| Command | What it does |
| --- | --- |
| `/status` | State, session id, JSONL log path, leaf id, active-branch message count, emotion, models, approval mode, memory dir. |
| `/clear` | Appends a `reset_boundary` entry and truncates the active context to empty. The prior branch stays on disk. |
| `/history [query]` | Recent prompt history, newest first, up to 20 entries. Optional substring filter. |
| `/sessions` | Lists JSONL sessions for this workspace, newest first, marking the active one with `*`. A session still awaiting its first message has no file yet, so it is absent and nothing is starred. |
| `/load <session-id\|file-name\|path>` | Loads a session by id, file name, or absolute path and makes it active. |
| `/new [title]` | Starts a fresh session and switches to it. The JSONL file is not created until the first message; until then the printed path is the planned one. |
| `/memory` | Mines the active conversation for durable facts and writes them to `MEMORY.md` / `USER.md`. `SOUL.md` is never touched. Idempotent — facts already present are skipped. |
| `/help` | Prints the command list. |
| `/exit`, `/quit` | Closes the runner and exits. |

`/status` output looks like:

```
Agent Status:
  State:    idle
  Session:  3dac40eb8d3865d3
  Leaf ID:  (root)
  Log file: /path/to/workspace/.myagent/sessions/.../<timestamp>_3dac40eb8d3865d3.jsonl
  Messages: 0 in active branch
  Emotion:  Valence: 0.00, Arousal: 0.20, Fatigue: 0.00
  OS:       darwin 27.0.0 (arm64)
  Main:     gpt-4o
  Review:   gpt-4o-mini (lenient)
  Approve:  interactive (this terminal)
  Memory:   /path/to/workspace/.myagent
```

`Leaf ID: (root)` means the active branch has no entries yet — typical for a brand-new session.

### Two-level Ctrl+C

`Ctrl+C` is context-sensitive:

- **While a turn is running** — the turn is aborted immediately. Any approval prompt waiting for your answer is cancelled first, so the loop can observe the abort instead of hanging on a prompt that will never be answered.
- **While idle** — the first press prints `Press Ctrl+C again or type /exit to quit.` and returns you to the prompt. A second press **within 2 seconds** exits.

### The approval gate

When AutoReview classifies a tool call as `ask_user`, the CLI renders a card before the tool runs:

```
⚠ [Approval Required] write_file (risk: high, by model)
  reason: <why it was flagged>
  args:   {"path":"notes/x.txt","content":"...","then_run":"wc -c notes/x.txt"}
Approve this command? [y/N]
```

Only an answer matching `y` or `yes` (case-insensitive) approves the command. **The default is No**: pressing Enter, answering anything else, or losing the prompt (Ctrl+D, a closed stdin, an aborted turn) all deny the command.

Denial is not fatal. The loop receives `[User Denied]: Execution rejected by user.` as an errored tool result and continues, letting the model adjust course rather than killing the turn.

Ordinary development commands (`read_file`, `ls`, `git status`, `git diff`, …) never reach this card. AutoReview only escalates mutating or sensitive operations, and hard-denies irrecoverable ones outright.

---

## Web console — `pnpm ui`

```bash
pnpm ui
```

Starts a local HTTP server and prints its binding:

```
=== SuperIU Web UI (@agent/ui) ===
  Listening:   http://127.0.0.1:3000
  Main model:  gpt-4o
  Tool model:  gpt-4o-mini (autoReview on)
  ...
  Assets:      /path/to/packages/ui/public
```

Open the printed URL. Bind address and port come from `HOST` and `PORT` (defaults `127.0.0.1:3000`).

> The console has **no authentication** and can run shell commands through the agent. Keep it on loopback unless you understand the exposure.

The console covers the same ground as the CLI: streaming turns, the approval card, session switching, prompt history, and a Settings dialog (⌘,) for credentials, models, and the interface language. Settings are persisted to `.myagent/ui-settings.json`, seeded from the environment on first run; the file wins once written. Slash pills in the UI expose `/clear`, `/status`, and `/sessions`.

The interface defaults to Chinese; see [Interface language](#interface-language) for the switch and the resolution order.

The window keeps a deliberately small primary surface: the message list, the composer, and a titlebar. Everything else lives in the **secondary menu** (`⌘J`, or the `More` button in the titlebar) — session switching, model routing, live status, the emotion/posture read-outs, session internals, prompt history, and the notify / palette / settings actions. It opens as a fixed drawer over the transcript, so opening it never reflows the conversation; `Esc`, the close button, or the scrim dismisses it. In the desktop shell the same panel is what the middle titlebar control opens, since macOS already draws the real traffic lights. Because a new session stays an unstarted draft until its first message, the session selector shows an `(未开始的新会话)` placeholder instead of a selectable entry, and the status panel qualifies the log path with `(not written yet)`.

> The toggle is `⌘J`, not `⌘M`: macOS reserves `⌘M` for Minimize in a plain browser tab (the page never receives the keydown), and in the Electron shell the Window menu's `{ role: 'minimize' }` carries `CommandOrControl+M` with `registerAccelerator: true`, so the native menu consumes it before the renderer. `⌘J` is free in both shells.

### HTTP API

All routes live under `/api/`. JSON in, JSON out, except `/api/chat`, which streams SSE. An unknown `/api/*` path returns `404 {"error":"Unknown API route: ..."}`; a known path with the wrong method returns `405` with an `Allow` header.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/api/status` | — | Agent status: `status`, `sessionId`, `leafId`, `sessionFile`, `sessionPersisted`, `messageCount`, `model`, `reviewModel`, `autoReview`, `modelChoices`, `modelRoutes`, `memoryDir`, `settingsFile`, `workstation`, `emotion`, `posture`. `sessionPersisted` is false while the session is still a draft, so the panel qualifies the log path with `(not written yet)`. `posture` is `{ key, label, modifier }`: `key` is one of `terse`, `cautious`, `constructive`, `driven`, `pragmatic` and is what the console localizes; `label` keeps the English string for non-localizing consumers; `modifier` is the verbatim system-prompt text. |
| `GET` | `/api/models` | — | Per-role routes: `{ main, review, title, memory }`, each `{ model, apiKey, baseURL, maxTokens }`. |
| `POST` | `/api/model` | `{ role, model }` | Switches a role's model at runtime and returns `{ role, model, routes }`. Takes effect on the next turn; never disturbs a running one. `role` defaults to `main`; valid roles are `main`, `review`, `title`, `memory`. Selecting `main` or `review` also persists to settings. `400` if `model` is missing or the role is unknown. |
| `GET` | `/api/settings` | — | Masked API key (`apiKeyMasked`, `apiKeySet`), `baseURL`, `modelName`, `reviewModelName`, `autoReview`, `language`, `modelChoices`, `settingsFile`, and an `env` block reporting which variables are set. |
| `POST` | `/api/settings` | partial settings | Applies and persists a settings patch, rebuilds the runner, and returns the new settings plus `{ restarted, sessionId }`. `409` if a turn is running — abort first. `language` is presentation-only, so changing it never rebuilds the runner. `400` on an unsupported language id. |
| `GET` | `/api/sessions` | — | Session list, each `{ id, title, timestamp, cwd, filePath, mtimeMs, active }`. Only sessions with at least one message are listed, so the active session is absent from the list while it is still an unstarted draft. |
| `POST` | `/api/sessions/new` | — | Starts a fresh session as an **unstarted draft**: nothing is written to disk until its first message, so it does not appear in `GET /api/sessions` yet; returns `{ status, messages }`. |
| `POST` | `/api/sessions/load` | `{ sessionIdOrPath }` | Loads a session; returns `{ status, messages }`. `400` if the field is missing, `404` if the session cannot be found. |
| `GET` | `/api/messages` | — | Active branch messages, each `{ id, role, content, createdAt, toolCalls, toolResults }`. |
| `POST` | `/api/clear` | — | Appends a `reset_boundary`; returns `{ status, messages }`. |
| `GET` | `/api/history?q=&limit=` | — | Prompt history, newest first. `limit` defaults to 20; `q` filters by substring. |
| `POST` | `/api/abort` | — | Resolves pending approvals as denied and aborts the turn; returns `{ ok, status }`. |
| `POST` | `/api/approve` | `{ toolCallId, approved }` | Answers a pending approval; returns `{ ok, toolCallId, approved }`. `400` if `toolCallId` is missing, `404` if nothing is pending for it. Only `approved: true` approves. |
| `POST` | `/api/shutdown` | — | Responds `{ ok: true }` then shuts the server down after a short flush delay. |
| `POST` | `/api/chat` | `{ prompt }` | Streams one agent turn as SSE (below). `400` if `prompt` is missing, `409` if the agent is busy. |

Static assets are served from `packages/ui/public`. A path that does not match a file falls back to `index.html` when it is a navigation request (`Accept: text/html`), so client-side routes survive a reload. Requests that escape the public directory are rejected.

### The `/api/chat` SSE stream

`EventSource` cannot POST, so the client uses `fetch` with a `ReadableStream` and parses `data:` frames itself. Every frame is one JSON object with a `type` field. The server sends `: ping` comment lines every 15 seconds as a keep-alive.

| `type` | Payload | Meaning |
| --- | --- | --- |
| `status` | `status` | Agent status changed. One of `idle`, `running`, `thinking`, `streaming`, `tool_calling`, `completed`, `aborted`, `error`. |
| `step` | `step`, `phase` | A loop iteration started. `step` is 1-based. |
| `chunk` | `text`, `phase` | Assistant text delta — append it. |
| `reasoning` | `text`, `phase` | Model reasoning delta, when the provider streams it. |
| `tool_call` | `name`, `args`, `phase` | The model requested a tool. |
| `approval_request` | `toolCallId`, `name`, `args`, `riskLevel`, `reason`, `reviewedBy` | AutoReview escalated this call to you. Answer with `POST /api/approve` using `toolCallId`. |
| `tool_result` | `name`, `result`, `isError`, `durationMs`, `approvalWaitMs`, `phase` | The tool finished. `durationMs` excludes time spent waiting on approval. |
| `error` | `message`, `phase` | A turn-level failure. |
| `done` | `finalText`, `sessionId`, `leafId`, `messageCount`, `emotion`, `posture` | Terminal frame for the turn. Always sent, including after an error. |

`phase` is `main` for the agent's own turn. The loop may run multiple `step`s before `done`.

A real turn looks like this — note that `approval_request` blocks the stream until you answer:

```
data: {"type":"status","status":"running"}
data: {"type":"status","status":"thinking"}
data: {"type":"step","step":1,"phase":"main"}
data: {"type":"status","status":"streaming"}
data: {"type":"chunk","text":"Writing the file. ","phase":"main"}
data: {"type":"status","status":"tool_calling"}
data: {"type":"tool_call","name":"write_file","args":{...},"phase":"main"}
data: {"type":"approval_request","toolCallId":"call_19","name":"write_file","args":{...},"riskLevel":"high","reason":"...","reviewedBy":"model"}
data: {"type":"tool_result","name":"write_file","result":"Successfully wrote ...","isError":false,"durationMs":15,"approvalWaitMs":5948,"phase":"main"}
data: {"type":"step","step":2,"phase":"main"}
data: {"type":"chunk","text":"All steps finished.","phase":"main"}
data: {"type":"status","status":"completed"}
data: {"type":"status","status":"idle"}
data: {"type":"done","finalText":"All steps finished.","sessionId":"...","leafId":"...","messageCount":4,"emotion":{...},"posture":{...}}
```

If the browser disconnects mid-turn, the server tears the turn down: pending approvals resolve as denied, the abort signal kills the tool process tree, and the turn cannot hang.

---

## macOS desktop shell — `@agent/desktop`

```bash
pnpm desktop
```

An Electron app named `SuperIU` that wraps the existing web console in a native window. It depends on `@agent/core` and `@agent/ui`; the main process starts the `@agent/ui` HTTP server **in-process** on an ephemeral port (`startServer({ port: 0 })`) and points the window at it, so the SPA, its API, and its session/approval behaviour are exactly the same as `pnpm ui`. Nothing is re-implemented for the desktop — the desktop layer only adds what a browser tab cannot provide.

**Launching requires a graphical session.** This is a native window with macOS vibrancy, so it cannot run headless over SSH or in a display-less environment. The package builds and its entry point (`dist/main.js`) exists; `pnpm --filter @agent/desktop exec electron --version` reports `v44.4.3`.

### Installing as a real macOS app

`pnpm desktop` is a *development* runner: it boots `node_modules/electron/dist/Electron.app`, whose bundle is named "Electron" (`CFBundleName = Electron`, `CFBundleIdentifier = com.github.Electron`). Spotlight resolves ⌘+Space queries through LaunchServices, which only knows about `.app` bundles in indexed locations carrying the product's own name — so a bare `electron .` can never be found by Spotlight, however the window is titled.

To get a first-class app, build and install the bundle:

```bash
pnpm app:install      # = pnpm --filter @agent/desktop run package:mac
```

`packages/desktop/scripts/bundle-mac.ts` then:

1. compiles `@agent/core`, `@agent/ui` and `@agent/desktop` if their `dist/` is stale;
2. copies `Electron.app` to `packages/desktop/dist/SuperIU.app` and renames the executable to `SuperIU`;
3. rewrites the identity in `Contents/Info.plist` (`CFBundleName`, `CFBundleDisplayName`, `CFBundleIdentifier = com.superiu.desktop`, `CFBundleExecutable`, `CFBundleIconFile`) and namespaces the four helper bundles under the same identifier;
4. installs `assets/icon.icns` as `Contents/Resources/app.icns`;
5. assembles `Contents/Resources/app` — the desktop `dist/`, the docs, and a `node_modules/` holding the exact runtime closure of `@agent/core` + `@agent/ui` (46 packages, with conflicting versions nested exactly as Node's resolver expects);
6. ad-hoc re-signs the bundle, because editing `Info.plist` invalidates the seal Electron ships with;
7. installs to `~/Applications/SuperIU.app`, clears quarantine, and registers with LaunchServices + `mdimport`.

Afterwards the app is a normal macOS application:

```bash
open -a SuperIU                  # by name
open -b com.superiu.desktop      # by bundle id
```

⌘+Space → `SuperIU` → Enter also works. To confirm Spotlight sees it:

```bash
mdls -name kMDItemDisplayName ~/Applications/SuperIU.app
mdfind "kMDItemFSName == 'SuperIU.app'"
```

The icon comes from `assets/icon-source.webp`, the original monochrome line-art drawing. `scripts/make-icon.swift` turns it into the app icon: it reduces the drawing to a two-tone mask (which discards the source's white sticker border and its soft drop shadow), crops to the ink's own bounding box, and centres it on a white 1024×1024 Big Sur squircle — an 824×824 plate on a 100px margin, matching Apple's own grid, so the Dock's perspective treatment lands correctly. Because the plate is white and the art is white-backed line work, the drawing reads as ink printed on the plate rather than a picture pasted onto it.

```bash
swift scripts/make-icon.swift assets/icon-source.webp assets/icon.png
```

`assets/icon.png` is the committed source of truth; `assets/icon.icns` is derived from it by `pnpm app:install` (via `sips` + `iconutil`, all ten sizes), so the two can never drift apart. Regenerate the PNG and re-run the packaging script whenever the artwork changes.

> Re-run `pnpm app:install` after changing any source. The script rebuilds stale packages automatically; only `--no-install` (bundle without installing) is needed for a dry run.

#### Distributing a build

To produce a shippable archive instead of installing locally:

```bash
pnpm --filter @agent/desktop run package:zip
```

`--zip` runs the same assembly, then writes `packages/desktop/dist/SuperIU-<version>-mac-<arch>.zip` via `ditto -c -k --keepParent`. The bundle is ~309 MB on disk (286 MB of it the Electron framework); the archive is ~126 MB, which is what a download costs. `ditto` is used rather than `zip` because it preserves the symlinks and extended attributes inside `Electron Framework.framework` that codesign verifies.

### Why a native shell exists at all

In a browser tab the OS and the browser own `Cmd+Q` and `Cmd+,` — a web page cannot intercept them. "Native macOS operations" (quit, settings, window control) is therefore undeliverable from `pnpm ui` alone. That gap is precisely what this package fills: it installs a real application menu whose accelerators are handled by Electron *before* the renderer ever sees a `keydown`.

### Keyboard shortcuts

The application menu is built in `src/menu.ts`. Accelerators fall into two groups, and the distinction is deliberate:

| Shortcut | Action | Handled by |
| --- | --- | --- |
| `Cmd+Q` | Quit SuperIU | **Electron application menu** (`role: 'quit'`) |
| `Cmd+,` | Settings… | **Electron application menu** → forwards `settings` to the SPA |
| `Cmd+N` | New Session | **Electron application menu** → forwards `new-session` |
| `Cmd+W` | Close window | **Electron application menu** (`role: 'close'`) |
| `Cmd+R` | Reload | **Electron application menu** (`role: 'reload'`) |
| `Alt+Cmd+I` | Toggle DevTools | **Electron application menu** |
| `Cmd+K` | Focus Input (menu) / command palette (SPA) — divergent, see note | **SPA** — advertised in the menu with `registerAccelerator: false` |
| `Cmd+.` | Abort Turn | **SPA** — advertised in the menu with `registerAccelerator: false` |
| `Cmd+J` | Toggle the secondary menu | **SPA**, also advertised in the menu (`registerAccelerator: false`) |

`Cmd+K`, `Cmd+.` and `Cmd+J` are the interesting case: the SPA already owns those keystrokes, so their menu items set `registerAccelerator: false` and dispatch the same action when clicked. One caveat: that option is documented `@platform linux,win32`, so on macOS the accelerator may still be registered and win the key event before the renderer; on linux/win32 the page keeps the key and the item only acts when clicked.

That divergence is harmless for `Cmd+.` (Abort) and `Cmd+J` (More), whose menu items dispatch exactly what the SPA's own handler does. It is **not** harmless for `Cmd+K`: the menu item is *Focus Input*, while the SPA binds ⌘K to the command palette. This is a pre-existing divergence — if macOS registers the accelerator, ⌘K in the desktop shell focuses the composer instead of opening the palette. It is out of scope here and left unchanged. `Cmd+Q` and `Cmd+,` are the mirror image: only the native menu can deliver them.

Menu actions are forwarded to the renderer over the `superiu:menu` channel as `{ action }` (see `src/ipc.ts`); the Edit and Window menus use standard macOS roles.

### Native integration

Beyond the menu, the shell adds:

- **Single-instance lock** — a second launch focuses the existing window instead of starting a second HTTP server and a second set of database handles.
- **Native notifications** and a **dock badge** (`setBadgeCount`), driven by the renderer over IPC.
- **Window chrome** — `titleBarStyle: 'hiddenInset'` with macOS `under-window` vibrancy; the SPA renders its own header bar with a matching drag region.
- **Graceful shutdown** — `before-quit` closes the in-process server handle before the app exits, so no orphan process or open SQLite handle outlives the window.
- **Documentation item** in the Help menu that opens `docs/shells-guide.md` locally. The bundler ships `docs/` inside the app payload, so the item works in the installed app too — not just in a checkout.

The renderer never touches `ipcRenderer` directly. A sandboxed preload (`src/preload.cts`, `contextIsolation: true`, `sandbox: true`) exposes a frozen `window.superiuDesktop` surface: `onMenu`, `setBadgeCount`, `showNotification`, `flashFrame`, `setLanguage`, and `quit`.

---

## Which shell should I use?

| | Terminal (`pnpm cli`) | Web console (`pnpm ui`) | Desktop (`pnpm desktop`) |
| --- | --- | --- | --- |
| Status | Available | Available | Available (requires a graphical session) |
| Best for | Scripting, piping, quick turns, working over SSH | Reading long output, reviewing diffs, clicking through approvals, session browsing | Day-to-day local use, with native menu, window chrome, and notifications |
| Streaming output | Yes, in-terminal | Yes, with structured tool cards | Same as the web console |
| Approval card | Terminal `[y/N]` prompt, defaults to No | In-page card with explicit Approve / Deny buttons | Same as the web console |
| Session switching | `/sessions`, `/load`, `/new` | Secondary menu (⌘J) | Same as the web console |
| Prompt history | `/history [query]` | Secondary menu (⌘J) | Same as the web console |
| Model switching | Edit `.env`, restart | Settings dialog, secondary menu, or `POST /api/model` at runtime | Same as the web console |
| Keyboard-driven | Yes | Partly (⌘J menu, ⌘K palette, ⌘, settings) | Yes — ⌘J, ⌘K and ⌘. in the SPA, plus ⌘Q / ⌘, / ⌘N in the native menu |
| Remote access | SSH into the host | HTTP — loopback by default, no auth | Local only — no remote access |

Rule of thumb: **terminal for speed and scripting, web console for anything you want to look at.** Both drive the same engine, the same session format, and the same approval policy, so switching between them mid-project is safe — sessions are shared per workspace.
