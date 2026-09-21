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
| `/sessions` | Lists JSONL sessions for this workspace, newest first, marking the active one with `*`. |
| `/load <session-id\|file-name\|path>` | Loads a session by id, file name, or absolute path and makes it active. |
| `/new [title]` | Starts a fresh JSONL session and switches to it. |
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

The console covers the same ground as the CLI: streaming turns, the approval card, session switching, prompt history, and a Settings dialog (⌘,) for credentials and models. Settings are persisted to `.myagent/ui-settings.json`, seeded from the environment on first run; the file wins once written. Slash pills in the UI expose `/clear`, `/status`, and `/sessions`.

### HTTP API

All routes live under `/api/`. JSON in, JSON out, except `/api/chat`, which streams SSE. An unknown `/api/*` path returns `404 {"error":"Unknown API route: ..."}`; a known path with the wrong method returns `405` with an `Allow` header.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/api/status` | — | Agent status: `status`, `sessionId`, `leafId`, `sessionFile`, `messageCount`, `model`, `reviewModel`, `autoReview`, `modelChoices`, `modelRoutes`, `memoryDir`, `settingsFile`, `workstation`, `emotion`, `posture`. |
| `GET` | `/api/models` | — | Per-role routes: `{ main, review, title, memory }`, each `{ model, apiKey, baseURL, maxTokens }`. |
| `POST` | `/api/model` | `{ role, model }` | Switches a role's model at runtime and returns `{ role, model, routes }`. Takes effect on the next turn; never disturbs a running one. `role` defaults to `main`; valid roles are `main`, `review`, `title`, `memory`. Selecting `main` or `review` also persists to settings. `400` if `model` is missing or the role is unknown. |
| `GET` | `/api/settings` | — | Masked API key (`apiKeyMasked`, `apiKeySet`), `baseURL`, `modelName`, `reviewModelName`, `autoReview`, `modelChoices`, `settingsFile`, and an `env` block reporting which variables are set. |
| `POST` | `/api/settings` | partial settings | Applies and persists a settings patch, rebuilds the runner, and returns the new settings plus `{ restarted, sessionId }`. `409` if a turn is running — abort first. |
| `GET` | `/api/sessions` | — | Session list, each `{ id, title, timestamp, cwd, filePath, mtimeMs, active }`. |
| `POST` | `/api/sessions/new` | — | Starts a fresh session; returns `{ status, messages }`. |
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
| `Cmd+K` | Focus Input | **SPA** — advertised in the menu with `registerAccelerator: false` |
| `Cmd+.` | Abort Turn | **SPA** — advertised in the menu with `registerAccelerator: false` |

`Cmd+K` and `Cmd+.` are the important case: the SPA already owns those keystrokes (command palette / abort), so their menu items set `registerAccelerator: false`. They still appear in the menu bar, are discoverable, and dispatch when clicked — but they do not steal the key event from the page. `Cmd+Q` and `Cmd+,` are the mirror image: only the native menu can deliver them.

Menu actions are forwarded to the renderer over the `superiu:menu` channel as `{ action }` (see `src/ipc.ts`); the Edit and Window menus use standard macOS roles.

### Native integration

Beyond the menu, the shell adds:

- **Single-instance lock** — a second launch focuses the existing window instead of starting a second HTTP server and a second set of database handles.
- **Native notifications** and a **dock badge** (`setBadgeCount`), driven by the renderer over IPC.
- **Window chrome** — `titleBarStyle: 'hiddenInset'` with macOS `under-window` vibrancy; the SPA renders its own header bar with a matching drag region.
- **Graceful shutdown** — `before-quit` closes the in-process server handle before the app exits, so no orphan process or open SQLite handle outlives the window.
- **Documentation item** in the Help menu that opens `docs/agent-loop-and-context-architecture.md` locally.

The renderer never touches `ipcRenderer` directly. A sandboxed preload (`src/preload.cts`, `contextIsolation: true`, `sandbox: true`) exposes a frozen `window.superiuDesktop` surface: `onMenu`, `setBadgeCount`, `showNotification`, `flashFrame`, and `quit`.

---

## Which shell should I use?

| | Terminal (`pnpm cli`) | Web console (`pnpm ui`) | Desktop (`pnpm desktop`) |
| --- | --- | --- | --- |
| Status | Available | Available | Available (requires a graphical session) |
| Best for | Scripting, piping, quick turns, working over SSH | Reading long output, reviewing diffs, clicking through approvals, session browsing | Day-to-day local use, with native menu, window chrome, and notifications |
| Streaming output | Yes, in-terminal | Yes, with structured tool cards | Same as the web console |
| Approval card | Terminal `[y/N]` prompt, defaults to No | In-page card with explicit Approve / Deny buttons | Same as the web console |
| Session switching | `/sessions`, `/load`, `/new` | Session picker in the UI | Same as the web console |
| Prompt history | `/history [query]` | History panel | Same as the web console |
| Model switching | Edit `.env`, restart | Settings dialog, or `POST /api/model` at runtime | Same as the web console |
| Keyboard-driven | Yes | Partly (⌘K palette, ⌘, settings) | Yes — ⌘K and ⌘. in the SPA, plus ⌘Q / ⌘, / ⌘N in the native menu |
| Remote access | SSH into the host | HTTP — loopback by default, no auth | Local only — no remote access |

Rule of thumb: **terminal for speed and scripting, web console for anything you want to look at.** Both drive the same engine, the same session format, and the same approval policy, so switching between them mid-project is safe — sessions are shared per workspace.
