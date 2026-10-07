# SuperIU

[![CI](https://github.com/Kayphoon/SuperIU/actions/workflows/ci.yml/badge.svg)](https://github.com/Kayphoon/SuperIU/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**One Core, Two Shells** — an autonomous coding agent built as a pure engine plus thin, swappable user interfaces.

The core knows nothing about terminals, colours, or GUIs. Every shell is a client of the same engine, so behaviour, session state, and safety policy are identical no matter where you drive it from. "Two shells" means two *presentation* families — the terminal, and the GUI (the web console and the macOS app).

| Layer | Package | Role |
| --- | --- | --- |
| Core | `@agent/core` | Session tree, context assembly, unbounded agent loop, tool execution, memory, review, emotion |
| Shell 1 | `@agent/cli` | Terminal REPL with streaming output and an interactive approval gate |
| Shell 2 | `@agent/ui` | Local web console — serves a browser SPA over HTTP |
| Shell 2 | `@agent/desktop` | macOS native shell, same GUI family — wraps `@agent/ui` in an Electron window |

## Quickstart

```bash
pnpm install
pnpm build
cp .env.example .env      # then fill in your credentials
```

`.env` is loaded by `@agent/core` via `dotenv` when the runner is constructed, so every shell reads the same configuration.

Launch a shell:

```bash
pnpm cli        # terminal REPL
pnpm ui         # local web console, http://127.0.0.1:3000
pnpm desktop    # macOS native shell (needs a graphical session)
pnpm app:install  # build + install SuperIU.app into ~/Applications (macOS)
pnpm app:zip    # build + write a distributable .zip instead of installing
pnpm test       # smoke suite + UI localization guard + cross-dictionary parity guard + provider credential wire guard
```

Type-checking without emitting:

```bash
pnpm typecheck  # type-check all @agent/* packages
```

> `pnpm desktop` launches the macOS shell, which embeds the same web console in an Electron window. It requires a graphical session — it cannot run headless. See [Architecture at a glance](#architecture-at-a-glance).

### Installing SuperIU as a macOS app

#### Option 1: One-line Install & Update (Recommended)

Run the following command in Terminal to install or update SuperIU automatically without macOS Gatekeeper warnings:

```bash
curl -fsSL https://raw.githubusercontent.com/Kayphoon/SuperIU/master/scripts/install-mac.sh | sh
```

This script automatically queries GitHub Releases for the latest version matching your Mac architecture (Apple Silicon `arm64` or Intel `x64`), downloads and unpacks `SuperIU.app` into `/Applications`, strips macOS Gatekeeper quarantine (`xattr -cr`), and registers it with LaunchServices/Spotlight. You can re-run the same command anytime to update to the latest release.

#### Option 2: Build & install from source

`pnpm desktop` is a development runner — it boots the Electron framework's own bundle, which is named "Electron", so Spotlight (聚焦搜索) cannot find it. To install SuperIU from source:

```bash
pnpm app:install
```

This builds `SuperIU.app` (own bundle identifier `com.superiu.desktop`, own icon, self-contained runtime) and installs it to `~/Applications`, then registers it with LaunchServices and Spotlight. Afterwards:

```bash
open -a SuperIU                # or: open -b com.superiu.desktop
```

…and ⌘+Space → `SuperIU` → Enter works too. Re-run `pnpm app:install` after changing source. Full details, including how the bundle is assembled, are in the [shells guide](docs/shells-guide.md#installing-as-a-real-macos-app).

### Updating a headless (VPS) server

The headless server is the standalone `superiu-server` binary (the same HTTP + WebSocket daemon as `pnpm ui`, with no window). `scripts/install.sh` installs it into `~/.superiu/bin` on Linux x86_64 / arm64 and is idempotent, so re-running it upgrades in place:

```bash
curl -fsSL https://raw.githubusercontent.com/Kayphoon/SuperIU/master/scripts/install.sh | sh
```

The daemon can also upgrade itself in place — it downloads the latest released Linux binary for the host architecture, swaps it atomically, and restarts:

```bash
superiu-server update --check        # report current vs. latest, change nothing
superiu-server update                # upgrade only when a newer version exists
superiu-server update --version 0.3.0  # pin an exact release
```

By default headless updates are operator-triggered: re-run `scripts/install.sh`, or call `superiu-server update`. There is **no background updater running out of the box**. The macOS desktop app remains the only component with an in-app auto-updater.

#### Opt-in idle auto-update

Set `--auto-update-idle` (or `SUPERIU_AUTO_UPDATE_IDLE=1`; `1`, `true`, and `yes` are truthy) to let the daemon upgrade itself in the background. Turn it back off with `--no-auto-update-idle` (or `SUPERIU_AUTO_UPDATE_IDLE=0|false|no`), which also forgets the persisted setting — without an explicit off, a daemon that was once enabled keeps the feature on across restarts. This is **off by default** — nothing happens until you enable it. The interval is `--auto-update-interval-hours <n>` (or `SUPERIU_AUTO_UPDATE_INTERVAL_HOURS`), default `6`, and must be greater than `0`; the first check runs one full interval after boot, never at startup.

A tick upgrades only when GitHub Releases reports a newer semver **and** the daemon is genuinely idle: no turn running, no turn waiting on a human approval, and no gateway turn in flight. Otherwise it logs a deferral and retries on the next tick. On an idle tick the server first downloads the release and verifies the downloaded binary's own `version` output (the same anti-loop gate as `superiu-server update`) **while it keeps serving normally**; only the final step — the atomic swap and restart — needs exclusivity, so the server enters **draining** for that millisecond-scale window, and `POST /api/chat` returns HTTP 503 (the WebSocket gateway refuses new prompt turns) only then, after any in-flight turn is allowed to finish. It then swaps the binary atomically and restarts with the original port, host, token, and workspace. When a systemd user unit exists, the restart goes through systemd first — but a unit restart cannot carry CLI flags, so enable the feature in the unit's `~/.superiu/env` instead (`SUPERIU_AUTO_UPDATE_IDLE=1`, plus `SUPERIU_AUTO_UPDATE_INTERVAL_HOURS` and `SUPERIU_RELEASE_BASE` if used); the daemon logs this hint at runtime when it restarts through systemd. The release base is `--release-base <url>` (or `SUPERIU_RELEASE_BASE`), honoured by idle auto-update and persisted in the daemon state file so it is replayed across the self-restart — a private mirror never silently falls back to the default GitHub channel.

A candidate version that fails is recorded in `<workspace>/.superiu/update-state.json` and not retried for 24 hours, so a broken release cannot crash-loop the daemon. Auto-update refuses to run unless the executable is named `superiu-server`, so `node dist/daemon.js` can never overwrite `node`.

## Configuration

All configuration is environment-driven. Copy `.env.example` to `.env` and set:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | `placeholder-key` | Credential for the model endpoint. |
| `OPENAI_BASE_URL` | SDK default | Any OpenAI-compatible endpoint (DeepSeek, SiliconFlow, Ollama, Moonshot…). |
| `OPENAI_MODEL_NAME` | `gpt-4o` | Main agent model that drives the loop. |
| `OPENAI_REVIEW_MODEL_NAME` | `OPENAI_MODEL_NAME`, else `gpt-4o-mini` | Model used for AutoReview arbitration. Typically cheaper; resolved independently of the main model. |
| `OPENAI_REASONING_EFFORT` | `medium` | `low`, `medium`, or `high` reasoning effort for thinking models; also scales the output token budget (2048 / 4096 / 8192, capped 16384). Applied only to models that accept the parameter; anything else is ignored. |
| `SUPERIU_AUTO_REVIEW` | `1` (on) | Set to `0` to disable the automatic approval gate entirely. |
| `SUPERIU_AUTO_REVIEW_MODE` | `lenient` | `lenient` or `strict`. Anything other than `strict` resolves to `lenient`. |
| `PORT` | `3000` | Port for the web console (`@agent/ui` only). |
| `HOST` | `127.0.0.1` | Bind address for the web console (`@agent/ui` only). |
| `SUPERIU_LANGUAGE` | `zh` | Interface language: `zh` or `en`. Seeds the default only — a `language` in the settings file wins over it. An unsupported value is ignored, falling back to the file and then to `zh`. |

The web console additionally persists the same settings to `.superiu/ui-settings.json` so they can be edited from the Settings dialog (⌘,) without touching `.env`. Environment variables seed the defaults; the settings file wins once written. The interface language and the **appearance** (System / Dark / Light) are among those settings and can both be switched at runtime from the same dialog — see [Interface language](docs/shells-guide.md#interface-language) and [Appearance](docs/shells-guide.md#appearance).

That dialog's **Model Configuration** pane manages providers rather than bare credential fields: each provider carries its own name, API key, Base URL, and model list, and exactly one is active — its key and Base URL are what the runner uses. Each provider keeps its own credential, so switching to one with no key of its own leaves the app unconfigured instead of sending the previous provider's key to a different endpoint. **Fetch models** probes the endpoint's live `GET /models` listing (`POST /api/models/fetch`), which resolves a stored key by endpoint, so no provider's credential is ever sent to another provider's host. A stored key is never sent back to the browser — leaving the field blank keeps it. Credentials remain in the same 0600 settings file.

Each model row additionally carries two per-model controls, stored under `modelConfigs` in the settings file. The **enable switch** decides whether the model is offered in the composer's model picker at all — fetching a gateway's listing must not flood the picker with models nobody intends to run, and a disabled model simply does not appear (it stays selectable from Settings, and the model currently in force is always shown). The **reasoning-level select** answers "does this model take `reasoning_effort`?" for models the built-in allowlist does not know: `Auto` defers to that allowlist, `All levels` / `Low only` / `Medium only` / `High only` declare which levels the model accepts, and `No reasoning parameter` declares that it refuses the parameter even though the allowlist would allow it. A declared level set is authoritative — the app then sends an explicit per-role level (the stored preference when it is in the list, otherwise the strongest allowed one), which is what lets a model outside the allowlist reason and what stops a level being sent to a model that rejects it. Both controls live behind the dialog's Save, like the rest of the provider form.

## Architecture at a glance

```mermaid
graph TD
  subgraph Shell1["Shell 1 — terminal"]
    CLI["@agent/cli<br/>REPL"]
  end

  subgraph Shell2["Shell 2 — GUI"]
    UI["@agent/ui<br/>web console"]
    DESK["@agent/desktop<br/>macOS"]
  end

  subgraph Core["@agent/core — pure Node engine"]
    RUNNER["AgentRunner<br/>public facade"]
    SESSION["SessionManager<br/>JSONL session tree"]
    CONTEXT["ContextAssembler<br/>+ SystemPromptBuilder"]
    LOOP["AgentLoopEngine<br/>sole tool executor"]
    REVIEW["AutoReviewer<br/>allow / ask_user / deny"]
    TOOLS["Tools<br/>bash · read_file · write_file"]
    MEM["Layered memory<br/>SOUL · USER · MEMORY"]
  end

  CLI --> RUNNER
  UI --> RUNNER
  DESK -.-> RUNNER
  RUNNER --> SESSION
  RUNNER --> CONTEXT
  RUNNER --> LOOP
  RUNNER --> MEM
  LOOP --> REVIEW
  LOOP --> TOOLS
  REVIEW -.->|ask_user| CLI
  REVIEW -.->|ask_user| UI
```

Shells depend on the core; the core never depends on a shell.

| Package | Responsibilities |
| --- | --- |
| `@agent/core` | JSONL session tree, context assembly, the unbounded loop, exclusive tool execution, three-tier memory, AutoReview, skills, emotion. |
| `@agent/cli` | Readline REPL, streaming output, two-level Ctrl+C interruption, slash commands, terminal `y/N` approval card (defaults to deny). |
| `@agent/ui` | Static SPA plus a small HTTP/SSE server that streams agent turns and exposes settings. |
| `@agent/desktop` | macOS native shell. Electron main process that embeds `@agent/ui` in-process, with a native application menu, window chrome, and notifications. |

For the full design — session storage internals, context compaction, prompt-cache layout, review evidence rules — see [`docs/agent-loop-and-context-architecture.md`](docs/agent-loop-and-context-architecture.md).

## Key capabilities

### Unbounded agent loop with exclusive tool authority

`AgentLoopEngine` is the only component that ever executes a tool. Before calling the model the adapter strips every tool's `execute` property, so the SDK can only ever *produce* `tool-call` parts. The loop runs `while (stepIndex < maxSteps)` with `maxSteps` defaulting to `Infinity`, and converges naturally when the model stops requesting tools. Each iteration re-assembles context rather than computing it once per session.

A throwing tool is caught, formatted as `[Tool Error in X]: <message>`, and fed back with `isError: true` so the model can self-correct instead of the turn dying.

### JSONL session tree, `leafId`, and the `/clear` boundary

Sessions are append-only JSONL trees at `<workspace>/.superiu/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`. Each entry carries `id` / `parentId` / `timestamp`; every append parents to the current mutable `leafId` pointer, so branching moves the pointer without rewriting history.

`buildSessionContext(leafId)` walks back to the root, reverses to chronological order, truncates at the most recent `reset_boundary`, and drops dangling tool calls and orphaned tool results. `/clear` appends a `reset_boundary` entry — a hard truncation boundary rather than a deletion, so the prior branch stays on disk and remains resumable.

Prompt history lives in a separate `node:sqlite` database (`.superiu/history.db`) decoupled from the session tree, written *before* the loop runs so an interrupted prompt is still remembered.

### Three-tier AutoReview with an interactive approval gate

Every tool call is classified before execution:

- **`allow`** — zero-latency, never shown. Read-only work: `read_file`, `ls`, `pwd`, `git status|diff|log`, `cat`, `head`, `tail`, `echo`.
- **`ask_user`** — escalated to the approval card. Sensitive or mutating work: `rm -rf dist|build|node_modules`, `git clean -fd`, `git reset --hard`, package installs, `curl`, `sudo`, writes outside the workspace.
- **`deny`** — irreversible or malicious, never offered: `rm -rf /`, `mkfs`, `dd if=/of=`, fork bombs, credential exfiltration.

The deliberate boundary: ordinary development commands are never hard-blocked, at most escalated to `ask_user` for a human to release. When the rule engine returns no verdict the `reviewModelName` model arbitrates. If that review model errors, times out, or returns unparseable output, the call is **escalated to `ask_user`** — fail-to-human, never fail-open.

The host supplies a `permissionGate` to render the card. Returning `false` yields `[User Denied]: Execution rejected by user.`; a missing gate yields `[AutoReview Pending Approval]`; a throwing gate yields `Approval channel failed`. All three feed back as `isError: true` and the loop continues rather than terminating. Hosts must resolve pending approvals when a turn is interrupted, or the loop waits forever.

### `then_run`: fuse a write with its verification

`write_file` accepts an optional `then_run` command, collapsing a write and its verification into a single tool call instead of burning an extra loop iteration:

```
Successfully wrote 1234 bytes to src/foo.ts

[then_run: pnpm typecheck]
<bash output>
```

If the write itself fails, `then_run` is short-circuited and never runs. It shares `executeBashCommand()` with the `bash` tool, so process-group kill, timeout, spillover, and abort propagation behave identically.

### `.agents/skills` protocol with lazy loading

Skills follow the public Agent Skills standard: `.agents/skills/<name>/SKILL.md` with YAML frontmatter carrying `name` and `description`. Both a workspace root and a user-global root are scanned; a workspace skill shadows a same-name user skill, and results are sorted by name so the prompt stays stable.

Loading is lazy. The system prompt carries only each skill's name, a one-line summary, and its absolute path — the body is read on demand. Summaries collapse to a single line and are capped, because that block is rebuilt every iteration and would otherwise grow linearly with the number of installed skills.

In this repository `.agents/skills` is a symlink to `.wiki/skills`, so project knowledge modules are exposed to the agent as skills.

### Spillover circuit breaker

A single tool output exceeding 2000 characters is written to disk (`<memoryDir>/spillover/spillover-<timestamp>-<id>.log`, falling back to the workspace when the memory directory is not writable). The model receives only an 800-character head and 800-character tail preview plus a pointer to read the file directly, so one verbose log cannot blow out the context window.

### Prompt-cache prefix contract

The system prompt is assembled static-first, volatile-last:

```
engineering directives → SOUL → USER → MEMORY → <skills> → <workstation> → extra instructions → operational posture
```

Provider prompt caching is prefix-matched byte-for-byte from token 0, and `<workstation>` embeds a per-turn ISO timestamp. Placing it early would force a cache miss on *every* step of an unbounded loop. Keeping it late — with the timestamp deliberately on its final line — leaves the shared prefix intact across steps.

**Never move `<workstation>` or any timestamp-bearing block ahead of the static section.**

### Emotion and operational posture

A three-axis state machine tracks `valence` [-1, 1], `arousal` [0, 1], and `fatigue` [0, 1] around baselines `0.0` / `0.2` / `0.0`. It decays exponentially toward those baselines with a five-minute half-life (`fatigue` decays at double).

Interactions update it: tool success nudges `valence` up, failure pulls it down, and each step accrues `fatigue`. The resulting posture is injected as a prompt modifier — high fatigue asks for terse output, negative valence sharpens scrutiny of edge cases, high arousal encourages driving multi-step verification.

## Slash commands

Available in the CLI REPL (`packages/cli/src/index.ts`):

| Command | Effect |
| --- | --- |
| `/status` | State, session id, JSONL path, leaf id, branch length, emotion, models, approval mode, memory dir. |
| `/clear` | Append a `reset_boundary` and truncate the active context. |
| `/history [query]` | Show recent prompt history, optionally filtered. |
| `/sessions` | List JSONL sessions for this workspace. |
| `/load <session-id\|file-name\|path>` | Load a session by reference. |
| `/new [title]` | Start a fresh JSONL session. |
| `/help` | Display the command list. |
| `/exit`, `/quit` | Close the runner and exit. |

The web console exposes a subset through its command palette (⌘K) and the composer's slash autocomplete (type `/`): `/clear`, `/status`, and `/sessions`.
