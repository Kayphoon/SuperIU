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
| Web console / desktop | Settings dialog (⌘,) → **界面语言 / Interface Language** | `.superiu/ui-settings.json` → `language` |
| macOS desktop | same control; the native menu bar rebuilds immediately | same file |
| Terminal | edit the `language` field, or set `SUPERIU_LANGUAGE=zh\|en` before `pnpm cli` when the file has no `language` | read-only — the CLI never writes the settings file, it only reads it |

Resolution order is the same everywhere: the `language` field in `.superiu/ui-settings.json` first, then an explicit `SUPERIU_LANGUAGE` environment variable, then `zh`. The file wins because it is the setting the dialog edits and the one the next launch reads — the environment variable only seeds the default for a workspace whose file does not set a language, exactly as it does for `apiKey` and the model names. A value the build cannot render is ignored rather than honored, so an older shell reading a newer settings file degrades to the default instead of showing a half-translated UI.

The web console also mirrors the choice into `localStorage` so the first paint after a reload is already in the right language, with no English flash while `/api/settings` is in flight. The settings file remains authoritative — it is what the dialog edits and what the desktop shell reads at launch to build its menu bar.

## Appearance

**System / Dark / Light**, in the same General pane as the interface language. The preference lives in `.superiu/ui-settings.json` → `theme` and is mirrored into `localStorage['superiu.theme']`, which the page's blocking pre-paint script reads before the first paint. That is what makes a reload free of the flash you get from applying a stored theme after `/api/settings` answers.

`system` follows the OS and tracks it live: a `prefers-color-scheme` change repaints immediately, without a reload. `dark` and `light` pin one scheme and deliberately ignore the OS.

In the desktop shell the preference is also mirrored onto Electron's `nativeTheme.themeSource`, so the native window frame, menu bar and the `under-window` vibrancy material behind the translucent panes match the scheme the page is painting. The main process reports the resolved scheme back over the `superiu:theme` IPC channel, so the two never disagree.

The pre-paint script resolves the scheme itself when the file has not answered yet — it is the only thing that can run before the first paint, and it reads the same `localStorage` key, so the value the settings file reports and the value that decides the first paint cannot drift.

Two things stay English on purpose, because translating them would break behaviour rather than improve it:

- The **operational posture** body in the secondary menu. That text is injected verbatim into the system prompt (`# OPERATIONAL POSTURE`), so the drawer shows the model's actual instructions; a translated copy would describe something the model never received. The posture *badge* itself is localized.
- Machine-readable values stay verbatim: model names, session ids and JSONL paths are data, never translated. The same holds for a raw id token — `idle`, `low`, or the value behind a chip's `data-level` — which stays untranslated even though the display word it maps to is localized (the status card prints `tr('status.card.state') + statusLabel(status)` in both shells, and `statusLabel`/`effortLevelLabel` resolve a known id through the dictionary). The identifier is data; the label and the display word for a known id are prose.

The desktop native menu is a main-process surface with its own small label table (`packages/desktop/src/menu.ts`); the browser dictionary (`packages/ui/public/i18n.js`) is not reachable from the packaged main process. The terminal has its own table (`packages/cli/src/language.ts`) for the same reason. The three tables deliberately share key *names* for shared concepts so the shells cannot drift semantically. That intent is enforced rather than merely stated: `scripts/check-dict-parity.mjs`, wired into `pnpm test`, slices each table by its language marker and asserts that zh and en cover identical keys, that the shared concepts they pair agree verbatim once each shell's own column padding is set aside — the eight `status.*` state words foremost, since both shells build that key dynamically off core's `AgentStatus` union — and that every value of a core enum the CLI interpolates into a user-visible string has a word mapping, so a raw token like `lenient` cannot leak. Divergences that are real and currently unfixed are listed explicitly with a reason and printed on every run; a new one fails the build.

---

## Terminal shell — `pnpm cli`

```bash
pnpm cli
```

An interactive REPL. On start it prints the resolved configuration so you can confirm what you are actually talking to:

```
=== SuperIU Autonomous Agent CLI ===
Main model: gpt-4o
Review model: gpt-4o-mini
Session: 3dac40eb8d3865d3
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
| `/new [title]` | Starts a fresh session and switches to it. The JSONL file is not created until the first message; the command reports the new session id only. |
| `/memory` | Mines the active conversation for durable facts and writes them to `MEMORY.md` / `USER.md`. `SOUL.md` is never touched. Idempotent — facts already present are skipped. |
| `/help` | Prints the command list. |
| `/exit`, `/quit` | Closes the runner and exits. |

`/status` output looks like:

```
Agent Status:
  State:    Idle
  Session:  3dac40eb8d3865d3
  Leaf ID:  (root)
  Log file: /path/to/workspace/.superiu/sessions/.../<timestamp>_3dac40eb8d3865d3.jsonl
  Messages: 0 in active branch
  Emotion:  Valence: 0.00, Arousal: 0.20, Fatigue: 0.00
  OS:       darwin 27.0.0 (arm64)
  Main:     gpt-4o
  Review:   gpt-4o-mini (Lenient)
  Approve:  interactive (this terminal)
  Memory:   /path/to/workspace/.superiu
```

`Leaf ID: (root)` means the active branch has no entries yet — typical for a brand-new session.

### Two-level Ctrl+C

`Ctrl+C` is context-sensitive:

- **While a turn is running** — the turn is aborted immediately. Any approval prompt waiting for your answer is cancelled first, so the loop can observe the abort instead of hanging on a prompt that will never be answered.
- **While idle** — the first press prints `Press Ctrl+C again or type /exit to quit.` and returns you to the prompt. A second press **within 2 seconds** exits.

### The approval gate

When AutoReview classifies a tool call as `ask_user`, the CLI renders a card before the tool runs:

```
⚠ [Approval Required] write_file (risk: high, by review model)
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

The console covers the same ground as the CLI: streaming turns, the approval card, session switching, prompt history, and a Settings dialog (⌘,) for credentials, models, the interface language, and the appearance. Settings are persisted to `.superiu/ui-settings.json`, seeded from the environment on first run; the file wins once written. The dialog is a preferences window with three submenus: **General** (interface language, appearance, reasoning effort, AutoReview, notifications), **Model Configuration** (providers and models), and **About** (product information and a local-storage note).

Model Configuration is a master–detail view. The left column lists the providers — starting completely **empty** on a fresh install, with no pre-seeded slots or fake choices — with a filter box and an **Add provider** menu (which offers quick templates for OpenAI, DeepSeek, Google Gemini, Anthropic, Ollama, OpenRouter, and Custom); the right column edits the selected one: name, enable switch, API key (masked, with a show/hide toggle), Base URL, and the model list. The list starts empty: an install with nothing configured shows no model anywhere — not in this grid, not in the composer pill, and not in the model picker — and the server writes none on its behalf. **Fetch models** calls `POST /api/models/fetch` to pull the endpoint's live `GET /models` listing; models can also be typed in manually, where the model-id field offers the shipped catalog as datalist suggestions (`knownModels`) without treating any of them as configured, and each row can be assigned as the main or the review model. At most one provider is active (or none, when unconfigured), and the top-level key and Base URL are a projection of it: each provider keeps its own credential, so switching to one that has no key leaves the app unconfigured rather than sending the previous provider's key to a different endpoint, and switching back restores it. A stored key is never re-displayed: leaving the field blank keeps the existing credential, which is what makes the masked round-trip safe. Provider labels and blurbs are localized by the console, and a provider you rename keeps your name. The footer reports unsaved changes and the save is a single `POST /api/settings`.

Every model row carries two per-model controls beyond its **Main** / **Review** assign buttons, and both live behind that same Save. The **enable switch** decides whether the model is offered in the composer's model picker: fetching a gateway's listing must not flood the picker with ids nobody intends to run, so a disabled model is dropped from the picker's groups and from the favorites list. The picker still pins the model currently in force unconditionally — hiding the model you are actually running would lie about the state — and Settings always lists every fetched model so a disabled one stays reachable. The **reasoning-level select** answers "does this model take a `reasoning_effort` parameter?" for models the built-in allowlist does not know:

| Option | Stored | Meaning |
| --- | --- | --- |
| Auto (follow the model capability) | no `efforts` | Defer to the built-in detector (`modelReasoning`) |
| All levels | `['low','medium','high']` | The model accepts any level |
| Low / Medium / High only | `['low']` etc. | The model accepts that level |
| No reasoning parameter | `[]` | The model refuses the parameter |

A stored `efforts` list is **authoritative**, in both directions. It widens the gate — a model outside the allowlist (`sensenova-6.8-flash-lite`, a private gateway model) reasons once its list is declared — and it narrows it, since `[]` suppresses the parameter on a model the allowlist would have allowed. The server implements this by putting an explicit level on the route (`POST /api/settings` → `runnerOptions()` gives **every** role whose model declares a level set its own route, since a role with no route of its own would inherit the router-wide default), because the core capability gate only decides the effort of a route that names **none**; an explicit effort is an instruction the router never second-guesses. The level chosen is the stored preference when the model's list contains it, otherwise the strongest level in the list — so narrowing a model from all three levels to `low` does not send a `high` the model would reject. A role on a model with **no** declared level set carries no route at all, so it keeps the router-wide default: the stored preference, unclamped. That default is deliberately the global preference rather than the main model's resolved level — a constrained `main` must not drag a role running on a different model down to its level. The per-model answers are exposed to the renderer as `modelConfigs` (only the entries the user actually configured) and `modelReasoning` (the built-in verdict per advertised id), which is what lets the select show `Auto` as a real state rather than an unknown.

The interface defaults to Chinese; see [Interface language](#interface-language) for the switch and the resolution order.

The window keeps a deliberately small primary surface: the message list, the composer, and a titlebar. Everything else lives in the **secondary menu** (`⌘J`, or the `More` button in the titlebar) — session switching, model routing, live status, the emotion/posture read-outs, session internals, prompt history, and the notify / palette / settings actions. It opens as a fixed drawer over the transcript, so opening it never reflows the conversation; `Esc`, the close button, or the scrim dismisses it. In the desktop shell the same panel is what the middle titlebar control opens, since macOS already draws the real traffic lights. Because a new session stays an unstarted draft until its first message, the session selector shows an `(未开始的新会话)` placeholder instead of a selectable entry, and the status panel qualifies the log file name with `(not written yet)`.

> The toggle is `⌘J`, not `⌘M`: macOS reserves `⌘M` for Minimize in a plain browser tab (the page never receives the keydown), and in the Electron shell the Window menu's `{ role: 'minimize' }` carries `CommandOrControl+M` with `registerAccelerator: true`, so the native menu consumes it before the renderer. `⌘J` is free in both shells.

### The composer toolbar

The composer carries three state controls on the left of its toolbar, in a fixed order: the reasoning-effort pill, the model pill, and the context-usage ring.

| Control | Kind | Reads | Writes |
| --- | --- | --- | --- |
| Reasoning-effort pill | button (`aria-haspopup`, `aria-expanded`) | `/api/status.reasoningEffort` | `POST /api/settings { reasoningEffort }` |
| Model pill | button (`aria-haspopup`, `aria-expanded`) | `/api/status.model` | `POST /api/settings { modelName, activeProviderId? }` |
| Context-usage ring | read-out (`<span role="img">`) | `/api/status.contextTokens` / `contextLimit` / `contextPercent` | — |

The ring is deliberately not a button: there is nothing to open, so a control that looks actionable but does nothing would lie about itself. It has no click handler and no place in the tab order. Its tooltip is the full reading — `12,450 / 1,000,000 (1%)`, with grouped digits and no locale formatting, so a monospace pill does not change width with the OS — while its `aria-label` is a sentence naming what the number measures — `Context usage 42%` (zh `上下文占用 42%`) — rather than the bare percentage, because a screen reader announcing `42%` alone gives no idea what is 42%.

One writer drives all three — `renderStatus()` calls `renderComposerControls(status)` last — so a status poll, a language switch, and a pick made in the toolbar can never disagree about what is in force. Each pill prefers the status payload and falls back to the settings view (`reasoningEffortEffective`, `modelName`) only until the first status arrives; the status payload wins because the secondary menu's own model selector reports through that same field, so a model changed from the menu moves this pill instead of leaving it on the previous one. The pills open their popovers *above* the toolbar, because the composer is pinned to the bottom of the window and a panel opening downward would put its list off-screen.

#### The model popover

Opening the panel clears its search box and focuses it, and the list is rebuilt on every open and on every keystroke, so it always reflects the live settings and favorites. The search is a case-insensitive substring match that filters every group — including the two pinned ones — and matching a *provider's* label shows all of that provider's models. The groups appear in this order:

- **Current** — only when the model in force is listed by no provider's `models[]`. A hand-edited settings file can name a model no provider carries, and a model removed from its provider after it was chosen leaves the same gap. Without the pinned row the picker would omit the model the user is actually running, and picking anything else would strand it beyond reach.
- **Favorites** — read from `localStorage['superiu.favoriteModels']` (an array of model ids, de-duplicated; unparseable JSON reads as empty rather than as an error, since the list is a convenience). Pinning them means they stay reachable after the provider that served them was deleted. A favorite no provider lists still selects; it simply cannot re-point the active provider.
- One group per provider that has at least one model, labelled by the provider's display name. Models a per-model config disables (`modelConfigs[id].enabled === false`) are omitted from every group and from the favorites list — that is the point of the switch — but the **Current** row above is never filtered, since it is in force.

A row's model gets capability badges wherever `modelMetadata` has an entry for it: an eye for image input, a wrench for tool calls, and the formatted context window (`1M`, `256K`, `128K`). The star is a nested button that toggles the bookmark and stops the click from bubbling — the row itself is what selects, so without that the act of bookmarking a model would also switch to it.

A pick posts a single `POST /api/settings` carrying `modelName` **and**, when the model actually changes, `activeProviderId`. The pair travels together because the active provider is a projection of the two computed jointly; sending the model alone would leave them disagreeing. A row for the model already in force carries **no** provider, and that is load-bearing: the provider in force is by definition the right one for that model, whereas a provider resolved from `providers[].models` is frequently a *different* one — a stock preset that happens to list the same id — and sending it silently detaches the app from the gateway and the credential the user configured. The renderer closes the same hole from the other side by preferring the provider already in force whenever it lists the model. If the active provider has an empty `models[]` (a custom gateway not yet populated) the panel appends a `<provider> has no models yet` hint rather than dropping it in silence, because a picker that omits the provider in force reads as broken; a filter that matches nothing at all gets a `No matching model` line instead.

A pick made from either popover while a turn is running is refused with a toast rather than queued, mirroring the `409` that `POST /api/settings` would answer with; the panel still closes.

#### The effort popover

One row per level the model in force is declared to accept, plus the `''` row — rebuilt on every open because their labels are dictionary lookups that a language switch has to re-resolve, and because the level set is a property of the current model. A model with no `modelConfigs` entry shows the four built-in rows (`''`, `low`, `medium`, `high`); a model narrowed to a single level shows that level and the `''` row; a model declared `efforts: []` shows no level rows at all and instead prints the `composer.effort.pending` hint, because storing a level it refuses would be a promise the app cannot keep.

The `''` row is **not** "off". It is the server's explicit *derive* value: the router attaches the model's own default to every model whose family accepts a `reasoning_effort` parameter, and attaches nothing at all to a model that does not. The default is `medium`, or `OPENAI_REASONING_EFFORT` when the environment sets one. Labelling that row "Off" would promise silence and deliver the default, so it reuses the settings pane's wording: **Unset — use the model default**.

The pill and the checked row answer two different questions from two different sources, and this is the part worth knowing:

| Surface | Source | Question |
| --- | --- | --- |
| The pill | `/api/status.reasoningEffort` | Which level is **in force** on the main route right now? |
| The checked row | `/api/settings.reasoningEffort` | Which level has been **stored** as the preference? |

They disagree whenever the stored preference and the resolved route differ, and that runs in both directions: a stored `''` on a reasoning-capable model resolves to the model default (`medium`), so the pill reads `Medium` (zh `中`) while the row reads `Unset`, and a level stored on a model that cannot take the parameter is stripped, so the pill reads `Off` while the row keeps the stored level. `POST /api/settings` validates only that the value parses — it never checks the model, and the runner rebuild it triggers succeeds regardless — so **a `2xx` alone is not evidence that the effort is in force**; it is the status payload that answers that, and the pill must never move on the response alone. The stored value is kept anyway, because it is what will apply once a capable model is active; the pill names that deferral in its title (`Saved — applies once a reasoning-capable model is active`) and the popover repeats it as a hint under the rows.

The same split explains the two labels for the empty value: the pill reads `Off` because that describes what goes on the wire, while the popover row reads `Unset — use the model default` because that describes what is stored.

#### The context meter

The ring is a read-out of the main model's context window, and its two halves come from different places.

The numerator is the provider's own `prompt_tokens` from the last step — the count the provider itself billed, so it already covers the system prompt and the tool schemas the branch does not contain. Before any step has run (a fresh session, a draft, or a runner just rebuilt by a settings save) it falls back to a character-based estimate of the active branch, roughly 3.5 characters per token, with tool calls and results counted at their JSON length. That fallback is what keeps the meter from reading zero for a conversation that is plainly not empty. Switching to another session and `/clear` discard the measurement as well — it belongs to the session the engine is bound to — so the meter re-derives from the branch now in force instead of continuing to show the conversation you left.

The denominator is the model metadata table's published window for the model in force, read from the *unresolved* base route — the window is a property of the model, not of the reasoning effort. `percent` is `tokens / limit` as a 0-100 integer, clamped, because a provider may report more than the table's window (a model the table does not know, or a window extended after this release).

The arc fills from 12 o'clock, the label is the percentage, and the tooltip is `tokens / limit (percent%)` with grouped digits. The colour is the part that matters at 10px: calm below 60%, amber from 60%, red from 85% — the point where a long turn starts compacting and the next step is likely to overflow. The meter also repaints from the `/api/chat` `done` frame, which carries the same three fields read after the last step, so a turn's own growth shows without a second round trip.

#### Dismissal and keyboard

A `mousedown` anywhere outside the composer closes both panels, and only one panel can be open at a time — two overlapping lists above the composer would hide the very control the user is comparing against.

`Escape` is handled on a capture-phase window listener, in layer order: the slash-completion menu first, then a composer popover, then any open modal (the secondary menu included), and only after all of those the running turn. Dismissing a model list must never abort the turn.

Within a popover, `ArrowDown`/`ArrowUp` move a roving focus through the rows and wrap, and `Enter` or `Space` activates the focused one; from the search box, `ArrowDown` steps into the list. The effort panel hands focus to the checked row when it opens, since it has no text field to start from; the model panel hands it to the search box, which is its entry point. A pick asks for the focus to return to the trigger, and gets it when the caret was inside the panel being hidden — otherwise focus would be left on a hidden row. An outside click does not: that is the user moving focus deliberately, and taking it back would fight them.

### HTTP API

All routes live under `/api/`. JSON in, JSON out, except `/api/chat`, which streams SSE. An unknown `/api/*` path returns `404 {"error":"Unknown API route: ..."}`; a known path with the wrong method returns `405` with an `Allow` header.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/api/status` | — | Agent status: `status`, `sessionId`, `leafId`, `sessionFile`, `sessionPersisted`, `messageCount`, `model`, `reviewModel`, `autoReview`, `modelChoices`, `modelRoutes`, `contextTokens`, `contextLimit`, `contextPercent`, `reasoningEffort`, `memoryDir`, `workstation`, `emotion`, `posture`. `sessionPersisted` is false while the session is still a draft, so the panel qualifies the log file name with `(not written yet)`. `contextTokens`/`contextLimit`/`contextPercent` are the main model's context meter: the token count is the provider's own `prompt_tokens` from the last step, falling back to a character-based estimate of the active branch when no step has run yet (a freshly loaded session); `contextLimit` comes from the model metadata table and `contextPercent` is `tokens / limit` as a 0-100 integer, clamped. `model`/`reviewModel` are `''` and `modelChoices` is `[]` until the user configures a model: the shipped preset catalogs are suggestions, never served as a selection. `reasoningEffort` is the effort actually in force on the main route — `''` when the model does not accept the parameter. `posture` is `{ key, label, modifier }`: `key` is one of `terse`, `cautious`, `constructive`, `driven`, `pragmatic` and is what the console localizes; `label` keeps the English string for non-localizing consumers; `modifier` is the verbatim system-prompt text. |
| `GET` | `/api/models` | — | Per-role routes: `{ main, review, title, memory }`, each `{ model, apiKey, baseURL, maxTokens }`. |
| `POST` | `/api/model` | `{ role, model }` | Switches a role's model at runtime and returns `{ role, model, routes }`. Takes effect on the next turn; never disturbs a running one. `role` defaults to `main`; valid roles are `main`, `review`, `title`, `memory`. Selecting `main` or `review` also persists to settings. `400` if `model` is missing or the role is unknown. |
| `GET` | `/api/settings` | — | Masked API key (`apiKeyMasked`, `apiKeySet`), `baseURL`, `modelName`, `reviewModelName`, `autoReview`, `language`, `theme`, `modelChoices`, `knownModels`, `providerTemplates`, `reasoningEffort`, `reasoningEffortEffective`, `reasoningSupported`, `modelMetadata`, `modelConfigs`, `modelReasoning`, and the provider surface: `activeProviderId` plus `providers[]` (each `{ id, name, enabled, baseURL, apiKeyMasked, apiKeySet, models, description, helpUrl, custom }` — never a plaintext key). `modelChoices` lists only the user's own models — each provider's `models[]` in provider order, then `modelName` and `reviewModelName`, de-duplicated — so an install with nothing configured serves `[]`; `knownModels` is the shipped id catalog, which the settings pane uses solely for the model grid's datalist autocomplete and no select renders. `providerTemplates` exposes quick creation presets (OpenAI, DeepSeek, Google Gemini, Anthropic, Ollama, OpenRouter). A provider's `models[]` is empty until the user fetches or types one. `modelMetadata` is a map keyed by model id, each `{ vision, tools, contextLimit, formattedContext }` (`formattedContext` being `1M` / `256K` / `128K`), covering every entry in `modelChoices`, every model in every provider's `models[]`, and both configured models — so a hand-typed model id has a window too. An unrecognised model gets the default 128K/tools/no-vision row. |
| `POST` | `/api/models/fetch` | `{ baseURL?, apiKey? }` | Probes `GET <baseURL>/models` on an OpenAI-compatible endpoint and returns `{ ok, models, error? }`. `ok: false` still answers `200`, so a bad key or an unreachable host is a normal renderable result rather than a transport failure. When `apiKey` is omitted the credential is resolved *by endpoint*: the key used is the one belonging to whichever provider owns that exact URL (trailing slash and case ignored), falling back to the active settings only when the URL is the active `baseURL`. An unrecognized endpoint is probed anonymously — no stored key travels to a host it does not belong to, and a keyless local endpoint such as Ollama works before it has ever been saved. There is deliberately no `providerId` parameter: an id-keyed lookup would let one provider's key be sent to another provider's host. |
| `POST` | `/api/settings` | partial settings | Applies and persists a settings patch, rebuilds the runner, and returns the new settings plus `{ restarted, sessionId }`. `409` if a turn is running — abort first. `language` and `theme` are presentation-only, so changing either never rebuilds the runner and a patch carrying nothing else is accepted mid-turn. `400` on an unsupported language id or theme (`system`, `dark`, `light`). Also accepts `activeProviderId` and `providers`; an empty or `••••`-containing `apiKey` means "keep the stored credential", `enabled` is recomputed so exactly the active provider is enabled, and the active provider's `apiKey`/`baseURL` are promoted to the top-level settings the runner uses — **unconditionally**, so a top-level `apiKey`/`baseURL` in the same patch cannot create a second source of truth. An `activeProviderId` no surviving entry carries falls back to the first one. A `modelConfigs` key is a **full replacement** of the per-model map (an omitted entry means "no opinion", which a merge could not express) and is validated before anything is stored: `{ <modelId>: { enabled?: boolean, efforts?: ('low'\|'medium'\|'high')[] } }`, with `efforts` normalized to canonical order and `[]` preserved as the explicit "refuses the parameter" answer. Malformed input answers `400` with a message naming the offending entry, and the stored map is left untouched. Any change to `modelConfigs` rebuilds the runner, because the per-role routes are derived from it. A patch carrying neither key leaves provider state untouched, so the pre-existing flat `{ baseURL }` form still behaves exactly as before. |
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
| `done` | `finalText`, `sessionId`, `leafId`, `messageCount`, `contextTokens`, `contextLimit`, `contextPercent`, `emotion`, `posture` | Terminal frame for the turn. Always sent, including after an error. The three `context*` fields are the same meter `/api/status` reports, read after the last step so they reflect the context size the turn actually ended with. |

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
data: {"type":"done","finalText":"All steps finished.","sessionId":"...","leafId":"...","messageCount":4,"contextTokens":500000,"contextLimit":1000000,"contextPercent":50,"emotion":{...},"posture":{...}}
```

If the browser disconnects mid-turn, the server tears the turn down: pending approvals resolve as denied, the abort signal kills the tool process tree, and the turn cannot hang.

### Headless server — `superiu-server`

The same server ships as a standalone Linux binary named `superiu-server`, installed by `scripts/install.sh` into `~/.superiu/bin`; it is what a VPS runs when there is no window to attach to. Updates are operator-triggered by default — re-run `scripts/install.sh`, or run `superiu-server update` (`--check` reports current vs. latest without changing anything, `--force` upgrades regardless, `--version <v>` pins a release), which downloads the latest released binary for the host architecture, swaps it atomically, and restarts the daemon. There is **no background updater out of the box**; the macOS desktop app remains the only component with an in-app auto-updater. The bundled `scripts/superiu-server.service` systemd user unit does not self-update either — it only `ExecStart`s the installed binary — but both `scripts/install.sh` and `superiu-server update` restart the unit themselves when a user unit exists, so no manual `systemctl --user restart superiu-server` is required after an upgrade.

Both shells upgrade **differentially** when the release publishes the extra metadata. The macOS release ships a `<zip>.blockmap` beside the zip: the client caches the zip it downloaded last time as `superiu-base.zip` in its temp directory, matches 64 KiB chunks by sha256, fetches only the missing byte ranges with HTTP `Range`, and stitches the new archive locally — after which the existing `ditto -x -k` unpack and atomic bundle swap run unchanged, so code signing and Gatekeeper are unaffected. The server release ships a `<binary>.patch` beside the binary, built with content-defined chunking (so a shifted region still matches) and carrying a 78-byte plaintext header; the daemon reads that header with a single ranged request and downloads the patch only when the binary on disk is byte-for-byte the one the patch was built from, then re-verifies the rebuilt binary's own `version` output exactly as before. Both paths fall back to the full download on any failure — a missing map or patch, an unmatched source, a `Range`-ignoring proxy, or a failed post-assembly sha256 check — so differential transfer can only ever save traffic, never break an update.

Opt in to idle auto-update with `--auto-update-idle` (or `SUPERIU_AUTO_UPDATE_IDLE=1`; `1`/`true`/`yes` are truthy), off by default; turn it off explicitly with `--no-auto-update-idle` (or `SUPERIU_AUTO_UPDATE_IDLE=0|false|no`), which also clears the persisted setting (precedence CLI > environment > persisted; note that an explicit `SUPERIU_AUTO_UPDATE_IDLE=0` therefore erases the persisted value, so removing the variable afterwards leaves the feature off until it is enabled again); the interval is `--auto-update-interval-hours <n>` (or `SUPERIU_AUTO_UPDATE_INTERVAL_HOURS`), default `6`, must be `> 0`, and the first tick runs one full interval after boot. A tick upgrades only when a newer semver exists and the daemon is genuinely idle (no turn running, none waiting on a human approval, no gateway turn in flight); otherwise it logs a deferral and retries next tick. On an idle tick the server first downloads the release and verifies the downloaded binary's own `version` output (the same anti-loop gate as `superiu-server update`) **while it continues to serve normally**; only the atomic swap and restart need exclusivity, so the server enters draining for that millisecond-scale window — `POST /api/chat` returns HTTP 503 and the WebSocket gateway refuses new prompt turns only then, after an in-flight turn finishes — and then swaps the binary and restarts with the original port/host/token/workspace (systemd-first when a user unit exists). The release base is `--release-base` / `SUPERIU_RELEASE_BASE`; idle auto-update honours it and replays it across the self-restart. Because a systemd unit restart cannot carry CLI flags, enable the feature in the unit's `~/.superiu/env` (`SUPERIU_AUTO_UPDATE_IDLE=1`, plus `SUPERIU_AUTO_UPDATE_INTERVAL_HOURS` / `SUPERIU_RELEASE_BASE` if used) rather than on the `start` command line. A failed version is recorded in `<workspace>/.superiu/update-state.json` and skipped for 24 hours to guard against crash loops. With idle auto-update enabled the daemon restarts itself, so the unit's `Restart=on-failure` is not relied upon.

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

### First-run onboarding

The desktop shell can drive two different agents, and which one it drives has to be decided **before** the app boots, because the choice determines whether the shell starts its own in-process engine at all. So a fresh install (no `.superiu/ui-settings.json`, or one that records neither `onboardingCompleted` nor a `connectionMode`) opens a dedicated onboarding window instead of the console, and nothing else is started until a mode is picked.

**Step 1 — 运行方式.** Two cards:

| Choice | What boots | When to pick it |
| --- | --- | --- |
| **本地 Agent** | The in-process `@agent/ui` server, exactly like `pnpm ui` | You want the engine on this Mac, with the user's home directory as the workspace. Zero setup; nothing leaves the machine. |
| **VPS 远程 Agent** | The SSH-managed remote flow: `~/.ssh/config` host → provision/start `superiu-server` on the VPS → local port-forward → `GatewayClient` | You want a 7×24 agent on a server, with the desktop as a thin client. |

**Step 2 — guidance.** Choosing *本地 Agent* shows a one-screen explanation (workspace = the user's home directory; API key and models are configured afterwards in Settings) and a single confirm button. Choosing *VPS 远程 Agent* hands off to the same seven-step deployment pipeline the Settings → 远程 VPS pane runs, rendered as a wizard: 探测远程系统 → 安装 / 校验 superiu-server → 准备远程工作目录 → 生成安全配对凭据 → 启动云端 Agent 守护进程 → 建立 SSH 加密隧道 → 连接并配对桌面客户端. Failures stop the pipeline on the offending step and offer 重试 / 返回编辑. The 远程工作目录 field opens pre-filled with `${home}/.superiu/workspace`, where `home` is derived from the selected host's ssh `user` (`root` → `/root`, otherwise `/home/<user>`) — the same derivation the Settings pane uses, so the two surfaces agree; the path is absolute, never `~`, because nothing downstream expands a tilde, and a manual edit is never overwritten when the host changes.

The choice is recorded in `.superiu/ui-settings.json` (`connectionMode` plus `onboardingCompleted: true`), so the wizard does not come back. **Both choices persist it when the wizard is used**: the local branch always records it, and the remote branch records it when the wizard's 设为启动时默认连接 switch is on — which it is by default. With that switch turned *off*, the remote session is deliberately session-only: nothing is written, so the wizard reappears on the next launch rather than the app silently reconnecting to a host the user declined to make the default. A machine that already carries a `connectionMode`, a configured gateway (`SUPERIU_GATEWAY_URL` + `SUPERIU_GATEWAY_TOKEN`), or a remote alias boots straight into that mode and never sees the wizard — which is also how an existing installation is migrated.

The onboarding window is a **separate window** from the console, and deliberately so: the remote pipeline paints its progress into the window it was given, so running the wizard inside the console window would replace the wizard with a status page the moment the first step starts. Two environment variables exist for scripted and CI runs: `SUPERIU_FORCE_ONBOARDING=1` shows the wizard regardless of what the settings file says, `SUPERIU_SKIP_ONBOARDING=1` suppresses it.

Because the desktop shell and the web console share one settings file, the file's keys have owners: the SPA owns the provider/model/appearance keys, the desktop shell owns `connectionMode` / `gateway` / `remote` / `onboardingCompleted`. Every write is a read-modify-write that preserves the keys the writer does not own — otherwise a trip through Settings → Save would delete the connection mode and the wizard would come back on every launch.

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
