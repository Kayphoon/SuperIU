import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentRunner,
  DEFAULT_MAIN_MODEL,
  DEFAULT_REVIEW_MODEL,
  MODEL_ROLES,
  getEmotionPromptModifier,
  modelMetadataFor,
  parseReasoningEffort,
  resolveMemoryDir,
  supportsReasoningEffort,
  type ContextMessage,
  type EmotionState,
  type ModelMetadata,
  type ModelRole,
  type ReasoningEffort,
  type RunnerCallbacks,
  type SessionDescriptor,
  type ToolCallItem
} from '@agent/core';
import type { ReviewResult } from '@agent/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 1_000_000;

export interface StartServerOptions {
  /** TCP port. `0` selects an ephemeral port. Defaults to `PORT` env or 3000. */
  port?: number;
  /** Bind address. Defaults to `HOST` env or 127.0.0.1. */
  host?: string;
  /** Workspace root owning `.myagent/` (sessions, history, settings). Defaults to cwd. */
  workspaceDir?: string;
  /** Directory holding `index.html` / `notifications.js`. Defaults to the package's `public/`. */
  publicDir?: string;
  /** Settings JSON path. Defaults to `<workspaceDir>/.myagent/ui-settings.json`. */
  settingsFile?: string;
  /** Suppress the startup banner. */
  quiet?: boolean;
}

export interface ServerHandle {
  /** Resolved port — the real one when `0` was requested. */
  port: number;
  host: string;
  url: string;
  /**
   * Language resolved at boot, so the desktop shell can build its native menu
   * in the right language before the renderer has loaded.
   */
  language: UiLanguage;
  /**
   * Appearance resolved at boot. The desktop shell mirrors it onto
   * `nativeTheme.themeSource` before the window exists, so the native material
   * behind a translucent window matches the scheme the renderer will paint —
   * the same reason `language` is reported here.
   */
  theme: Theme;
  /** Idempotent: resolves pending approvals, closes the HTTP server and the agent runner. */
  close(): Promise<void>;
}

// Resolved by startServer so the module can be imported without side effects.
let PUBLIC_DIR = path.resolve(HERE, '..', 'public');
let SETTINGS_FILE = path.join(process.cwd(), '.myagent', 'ui-settings.json');

/**
 * Models offered in the secondary menu's model selector; free-text entry is also
 * accepted.
 *
 * Every id here is one its vendor's own model list currently serves, because a
 * retired id is not merely stale copy: picking one sends a request the provider
 * answers with an error, and the metadata table has no window for it. One
 * current tier per vendor, plus the reasoning tiers the effort allowlist covers
 * (`gemini-3.8-flash`, `deepseek-flash`), so the composer's effort pill is
 * exercised by a model the user can actually select.
 */
const MODEL_CHOICES: string[] = [
  'gpt-6-astra',
  'gpt-5.6-terra',
  'gpt-4o',
  'claude-sonnet-5',
  'claude-opus-5-5',
  'claude-haiku-4-5',
  'gemini-3.8-flash',
  'gemini-2.5-flash',
  'deepseek-flash',
  'deepseek-v4-pro',
  'qwen3.8-max',
  'kimi-k3'
];

/**
 * UI language ids, shared with the SPA's `i18n.js` and persisted verbatim in
 * `ui-settings.json`. Chinese is the product default; English stays first-class.
 */
export type UiLanguage = 'zh' | 'en';
export const UI_LANGUAGES: readonly UiLanguage[] = ['zh', 'en'];
export const DEFAULT_LANGUAGE: UiLanguage = 'zh';

/**
 * Accepts stray case/whitespace from a hand-edited settings file; anything
 * unrecognised yields `undefined` so each caller picks its own fallback.
 */
function parseLanguage(value: unknown): UiLanguage | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return UI_LANGUAGES.find((id) => id === normalized);
}

/**
 * Appearance preferences, shared with the SPA's pre-paint script in
 * `index.html` and persisted verbatim in `ui-settings.json`. `system` defers to
 * the OS appearance (and tracks it live); `dark` / `light` pin one scheme.
 */
export const THEMES = ['system', 'dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = 'system';

/**
 * Same contract as {@link parseLanguage}: tolerate stray case/whitespace from a
 * hand-edited settings file, and yield `undefined` for anything unrecognised so
 * each caller picks its own fallback.
 */
function parseTheme(value: unknown): Theme | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return THEMES.find((id) => id === normalized);
}

export interface ProviderConfig {
  id: string;
  name: string;
  enabled: boolean;
  apiKey: string;
  baseURL: string;
  models: string[];
  description: string;
  helpUrl: string;
  custom: boolean;
}

/**
 * Built-in provider presets, in display order. `name` here is the provider's
 * DEFAULT label: the renderer localizes it through its dictionary and only shows
 * a user's own rename verbatim, which is why `settingsView()` also reports
 * `presetName` — it is the value a stored name must differ from to count as a
 * rename.
 *
 * Only public, stable endpoints belong here. A private relay or a user's own
 * gateway must NOT be baked in: it would ship someone's personal hostname in the
 * product source and rot the moment they change it. Unmatched endpoints land in
 * the `custom` slot instead.
 *
 * `models` is a short, representative slice of what each vendor currently
 * serves — not an exhaustive catalog — so every entry must still be a live id
 * from that vendor's own model list. A retired id here is worse than a missing
 * one: it is offered in the model grid and cannot succeed when picked.
 */
const PROVIDER_PRESETS: ReadonlyArray<{
  id: string;
  name: string;
  match: string;
  baseURL: string;
  helpUrl: string;
  models: string[];
  custom: boolean;
}> = [
  {
    id: 'openai',
    name: 'OpenAI',
    match: 'api.openai.com',
    baseURL: 'https://api.openai.com/v1',
    helpUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-4o', 'gpt-4.1'],
    custom: false
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    match: 'api.anthropic.com',
    baseURL: 'https://api.anthropic.com/v1',
    helpUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5'],
    custom: false
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    match: 'generativelanguage.googleapis.com',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    helpUrl: 'https://aistudio.google.com/app/apikey',
    models: ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    custom: false
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    match: 'api.deepseek.com',
    baseURL: 'https://api.deepseek.com/v1',
    helpUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    custom: false
  }
];

/** The custom slot's id; it has no preset row and is the user's to name. */
const CUSTOM_PROVIDER_ID = 'custom';

/**
 * One-time migration key: the `models[]` list each preset shipped BEFORE the
 * current catalog, keyed by provider id.
 *
 * `loadSettings()` only calls `createDefaultProviders()` when a file has no
 * `providers` at all, so an existing `ui-settings.json` keeps whatever lists it
 * was written with — the refreshed catalog above is invisible to it, and the
 * model picker keeps offering ids the vendor has since retired. This table
 * lets a stored list be recognized as "the old shipped default" and moved
 * forward.
 *
 * Entries are removed once no shipped version can have written them (i.e. once
 * a build old enough to write this list is no longer in the wild). Do not add
 * a list here speculatively: a wrong entry would silently overwrite a user's
 * own edit.
 */
const LEGACY_PRESET_MODELS: Readonly<Record<string, readonly string[][]>> = {
  openai: [['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini', 'o1']],
  anthropic: [['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022']],
  gemini: [['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash']],
  deepseek: [['deepseek-chat', 'deepseek-reasoner']]
};

/**
 * Move a stored preset's model list forward, but ONLY when it is still exactly
 * the list an earlier build shipped.
 *
 * The safety property is the exact match: same length AND same order. A stored
 * list that differs by even one id — added, removed, or reordered — is a user
 * edit, and any looser test (substring, subset, set equality) would silently
 * discard it. When the list is not a known shipped list the provider is left
 * completely untouched, including every field other than `models`.
 *
 * The returned value is in memory only; the caller's next `persistSettings()`
 * writes it. Migrating here must never write to disk on its own, or merely
 * reading settings would mutate the user's file.
 */
function migratePresetModels(provider: ProviderConfig): ProviderConfig {
  const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === provider.id);
  const legacyLists = LEGACY_PRESET_MODELS[provider.id];
  if (!preset || !legacyLists) return provider;

  const isShippedList = legacyLists.some(
    (legacy) => legacy.length === provider.models.length && legacy.every((id, i) => id === provider.models[i])
  );
  if (!isShippedList) return provider;

  // A fresh array, never the preset's own: assigning the constant would let a
  // later in-place edit of one provider's models corrupt the preset itself.
  return { ...provider, models: [...preset.models] };
}

/** Default label of a preset, or '' when the id has no preset (e.g. `custom`). */
function presetNameFor(id: string): string {
  return PROVIDER_PRESETS.find((preset) => preset.id === id)?.name ?? '';
}

function createDefaultProviders(currentApiKey: string, currentBaseURL: string): ProviderConfig[] {
  const base = currentBaseURL.trim();
  const hosts: string[] = [];
  try {
    if (base) hosts.push(new URL(base).host.toLowerCase());
  } catch {
    /* A bare host or a hand-edited value: fall back to a substring match below. */
  }
  const matches = (needle: string): boolean => hosts.some((host) => host.includes(needle)) || base.includes(needle);

  const presetsWithState = PROVIDER_PRESETS.map((preset) => {
    const enabled = Boolean(base) && matches(preset.match);
    return {
      id: preset.id,
      name: preset.name,
      enabled,
      apiKey: enabled ? currentApiKey : '',
      baseURL: preset.baseURL,
      models: preset.models,
      // Not shipped from the server: the renderer localizes the blurb from its
      // dictionary, so only a user-typed description ever occupies this field.
      description: '',
      helpUrl: preset.helpUrl,
      custom: preset.custom
    };
  });

  // No preset matched: the configured endpoint is a hand-rolled one, so keep it
  // in a dedicated custom slot instead of losing it behind a preset's URL.
  // Deliberately nameless: a display label baked in here would be a Chinese
  // literal leaking into an English UI, and this slot is the user's to name.
  const matched = presetsWithState.some((preset) => preset.enabled);
  presetsWithState.push({
    id: CUSTOM_PROVIDER_ID,
    name: '',
    enabled: Boolean(base) && !matched,
    apiKey: base && !matched ? currentApiKey : '',
    baseURL: base && !matched ? base : '',
    models: [],
    description: '',
    helpUrl: '',
    custom: true
  });

  return presetsWithState;
}

/**
 * Labels an earlier build baked into the custom provider slot. Matched on load
 * and cleared, so a localized default can take over instead of the literal
 * surviving in the settings file forever.
 */
const LEGACY_CUSTOM_PROVIDER_LABELS = ['自定义服务商', 'Custom provider'];

interface UiSettings {
  apiKey: string;
  baseURL: string;
  /** Main agent model — editable from both Settings and the secondary menu. */
  modelName: string;
  /** Tool/review model — Settings only. */
  reviewModelName: string;
  autoReview: boolean;
  /**
   * Provider reasoning effort applied to every reasoning-capable route.
   * `''` means "derive": the env value, else the core default (`medium`).
   */
  reasoningEffort: ReasoningEffort | '';
  /** Presentation only: switching it must never rebuild the runner. */
  language: UiLanguage;
  /** Presentation only: switching it must never rebuild the runner. */
  theme: Theme;
  activeProviderId?: string;
  providers?: ProviderConfig[];
}

export type PostureKey = 'terse' | 'cautious' | 'constructive' | 'driven' | 'pragmatic';

interface PostureView {
  key: PostureKey;
  label: string;
  modifier: string;
}

/**
 * Posture badge derived from the same thresholds as the core prompt modifier.
 * `label` stays English for the CLI and API consumers that already read it;
 * the SPA ignores it and renders `t('posture.' + key)` in the active language.
 */
function describePosture(emotion: EmotionState): PostureView {
  const modifier = getEmotionPromptModifier(emotion);
  if (emotion.fatigue > 0.7) return { key: 'terse', label: 'Terse & Direct', modifier };
  if (emotion.valence < -0.3) return { key: 'cautious', label: 'Cautious & Focused', modifier };
  if (emotion.valence > 0.5) return { key: 'constructive', label: 'Constructive & Proactive', modifier };
  if (emotion.arousal > 0.6) return { key: 'driven', label: 'Driven & Deep-Diving', modifier };
  return { key: 'pragmatic', label: 'Pragmatic & Rigorous', modifier };
}

function serializeMessages(messages: ContextMessage[]) {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content ?? '',
    createdAt: message.createdAt,
    toolCalls: message.toolCalls ?? [],
    toolResults: message.toolResults ?? []
  }));
}

function loadSettings(): UiSettings {
  const defaults: UiSettings = {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    baseURL: process.env.OPENAI_BASE_URL ?? '',
    modelName: process.env.OPENAI_MODEL_NAME ?? DEFAULT_MAIN_MODEL,
    reviewModelName: process.env.OPENAI_REVIEW_MODEL_NAME ?? DEFAULT_REVIEW_MODEL,
    autoReview: (process.env.SUPERIU_AUTO_REVIEW ?? '1') !== '0',
    reasoningEffort: parseReasoningEffort(process.env.OPENAI_REASONING_EFFORT) ?? '',
    language: parseLanguage(process.env.SUPERIU_LANGUAGE) ?? DEFAULT_LANGUAGE,
    theme: DEFAULT_THEME,
    activeProviderId: 'openai'
  };

  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) as Partial<UiSettings>;
    const effectiveKey = typeof raw.apiKey === 'string' ? raw.apiKey : defaults.apiKey;
    const effectiveBaseURL = typeof raw.baseURL === 'string' ? raw.baseURL : defaults.baseURL;

    let providers = Array.isArray(raw.providers) && raw.providers.length > 0
      ? raw.providers.map((p) => ({
          id: String(p.id || '').trim(),
          name: String(p.name || '').trim(),
          enabled: Boolean(p.enabled),
          apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
          baseURL: typeof p.baseURL === 'string' ? p.baseURL : '',
          models: Array.isArray(p.models) ? p.models.map(String) : [],
          description: typeof p.description === 'string' ? p.description : '',
          helpUrl: typeof p.helpUrl === 'string' ? p.helpUrl : '',
          custom: Boolean(p.custom)
        })).filter((p) => p.id)
      : [];

    // A file written by a build that baked the custom slot's Chinese label into
    // `name` would otherwise pin that literal forever, and it would surface
    // untranslated in an English UI. Clear it so the renderer can supply the
    // localized default.
    for (const provider of providers) {
      if (provider.id === 'custom' && LEGACY_CUSTOM_PROVIDER_LABELS.includes(provider.name)) {
        provider.name = '';
      }
    }
    providers = providers.filter((p) => p.id);

    // Move a preset still carrying an earlier build's model list onto the
    // current catalog. Exact-match only, so a user's own edit survives; see
    // `migratePresetModels`. In memory only — the next persist writes it.
    providers = providers.map(migratePresetModels);

    if (providers.length === 0) {
      providers = createDefaultProviders(effectiveKey, effectiveBaseURL);
    }

    const activeProviderId = typeof raw.activeProviderId === 'string' && raw.activeProviderId
      ? raw.activeProviderId
      : (providers.find((p) => p.enabled)?.id || providers[0]?.id || 'openai');

    return {
      apiKey: effectiveKey,
      baseURL: effectiveBaseURL,
      modelName: typeof raw.modelName === 'string' && raw.modelName ? raw.modelName : defaults.modelName,
      reviewModelName:
        typeof raw.reviewModelName === 'string' && raw.reviewModelName
          ? raw.reviewModelName
          : defaults.reviewModelName,
      autoReview: typeof raw.autoReview === 'boolean' ? raw.autoReview : defaults.autoReview,
      reasoningEffort: parseReasoningEffort(raw.reasoningEffort) ?? defaults.reasoningEffort,
      language: parseLanguage(raw.language) ?? defaults.language,
      theme: parseTheme(raw.theme) ?? defaults.theme,
      activeProviderId,
      providers
    };
  } catch {
    return {
      ...defaults,
      providers: createDefaultProviders(defaults.apiKey, defaults.baseURL),
      activeProviderId: 'openai'
    };
  }
}

/**
 * Write the settings file, reporting failure as a stable sentence.
 *
 * The raw `ENOTDIR`/`EACCES` message embeds the absolute path of the settings
 * file, and `applySettings` failures travel straight into the Settings dialog
 * (`index.html` renders `err.message` verbatim). So the filesystem detail is
 * logged server-side — redacted, like every other diagnostic on this surface —
 * and the caller only ever sees a sentence. Validation errors thrown by
 * `applySettings` itself are deliberate user-facing copy and never pass through
 * here.
 */
function persistSettings(next: UiSettings): void {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    console.error(`[server] settings save failed: ${redactSecrets(errorMessage(err), 300)}`);
    throw new Error('Could not save settings. Check the server log for details.');
  }
}

/** Never echo a raw credential back to the browser; show a recognisable stub instead. */
function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 10) return '••••••••';
  return `${key.slice(0, 5)}••••${key.slice(-4)}`;
}

/**
 * Pending interactive approvals, keyed by `toolCall.id`.
 *
 * A tool call flagged `ask_user` parks inside the core loop until the browser
 * answers; every entry is force-resolved when the stream dies so a turn can
 * never hang on a disconnected client.
 */
type ApprovalResolver = (approved: boolean) => void;
const pendingApprovals = new Map<string, ApprovalResolver>();

/** Wall-clock time each approval spent waiting on a human, queued per tool name. */
const approvalWaits = new Map<string, number[]>();
const approvalStartedAt = new Map<string, number>();
const approvalToolNames = new Map<string, string>();

function resolvePendingApprovals(approved: boolean): void {
  for (const [id, resolve] of pendingApprovals) {
    recordApprovalWait(id);
    resolve(approved);
  }
  pendingApprovals.clear();
}

function recordApprovalWait(toolCallId: string): void {
  const startedAt = approvalStartedAt.get(toolCallId);
  const name = approvalToolNames.get(toolCallId);
  if (startedAt === undefined || name === undefined) return;
  const stack = approvalWaits.get(name) ?? [];
  stack.push(Math.max(0, Date.now() - startedAt));
  approvalWaits.set(name, stack);
  approvalStartedAt.delete(toolCallId);
  approvalToolNames.delete(toolCallId);
}

/**
 * Every credential the runner ACTUALLY resolved, for redaction.
 *
 * `runnerOptions()` above is what the runner is built FROM; this is what it
 * resolved TO, and the two are not the same set. `AgentRunner` falls back to
 * `OPENAI_API_KEY` when `settings.apiKey` is empty, and `applySettings` blanks
 * the stored key (`next.apiKey = activeProvider?.apiKey ?? ''`) when the active
 * provider is keyless — so a key that lives only in the environment is sent
 * upstream while being invisible to every `settings`-derived scan.
 * `blankConfiguredSecrets` reads `settings`, so without this the provider's own
 * 401 envelope (`Incorrect API key provided: …`) reaches the transcript and the
 * desktop notification verbatim.
 *
 * Read from `getModelRoutes()` — the resolved routes the provider factories are
 * handed — rather than from `config.apiKey`, because a role may name its own
 * credential, and the env fallback is applied by the runner, not by the
 * embedder. Each route's `baseURL` is scanned too: it may embed a key
 * (`?api_key=…`, `token@host`) that no other field carries.
 */
function resolvedCredentials(target: AgentRunner): string[] {
  const found: string[] = [];
  for (const route of Object.values(target.getModelRoutes())) {
    if (route.apiKey) found.push(route.apiKey);
    found.push(...credentialsInUrl(route.baseURL));
  }
  return found;
}

function runnerOptions(sessionReference?: string, historyDbPath?: string, newSession = false) {
  return {
    apiKey: settings.apiKey || undefined,
    baseURL: settings.baseURL || undefined,
    modelName: settings.modelName || undefined,
    reviewModelName: settings.reviewModelName || undefined,
    autoReview: settings.autoReview,
    // `''` means derive (env, else core's `medium`). An explicit option wins
    // over `OPENAI_REASONING_EFFORT`, matching how the other settings resolve.
    defaultReasoningEffort: settings.reasoningEffort || undefined,
    sessionId: sessionReference,
    // A draft has no file to reopen, so a rebuild must skip the resume path
    // rather than be handed a path that does not exist yet.
    newSession,
    historyDbPath,
    permissionGate: async (toolCall: ToolCallItem, review: ReviewResult): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        pendingApprovals.set(toolCall.id, resolve);
        approvalStartedAt.set(toolCall.id, Date.now());
        approvalToolNames.set(toolCall.id, toolCall.name);
        approvalSink?.({
          type: 'approval_request',
          toolCallId: toolCall.id,
          name: toolCall.name,
          args: toolCall.args,
          riskLevel: review.riskLevel,
          reason: review.reason,
          reviewedBy: review.reviewedBy
        });
      })
  };
}

/** Set for the duration of one SSE turn so the gate above can reach the browser. */
let approvalSink: ((payload: unknown) => void) | null = null;

/** Installed by startServer so `POST /api/shutdown` can close the live instance. */
let shutdownHook: (() => void) | null = null;

// Created by startServer: importing this module must have no side effects.
let settings: UiSettings = loadSettings();
let runner: AgentRunner = null as unknown as AgentRunner;
let memoryDir = '';

interface PublicModelRoute {
  model: string;
  maxTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  hasApiKey: boolean;
}

/**
 * Routes without credentials: the console is unauthenticated and can run
 * arbitrary shell commands, so it must not hand out keys — or the endpoints
 * they belong to. `hasApiKey` keeps "configured / not configured" visible.
 */
function publicRoutes(): Record<string, PublicModelRoute> {
  const routes = runner.getModelRoutes();
  return Object.fromEntries(
    Object.entries(routes).map(([role, route]) => [
      role,
      {
        model: route.model,
        maxTokens: route.maxTokens,
        reasoningEffort: route.reasoningEffort,
        hasApiKey: Boolean(route.apiKey)
      }
    ])
  );
}

/**
 * Capability metadata for every model the console can offer, keyed by id.
 *
 * The union of the preset list, every provider's own model list, and the two
 * models currently configured — a provider's `models[]` is where a hand-typed
 * id lands, so covering only `MODEL_CHOICES` would leave the user's own model
 * without a context window and the usage meter dividing by the default.
 */
function modelMetadataView(): Record<string, ModelMetadata> {
  const ids = new Set<string>(MODEL_CHOICES);
  for (const provider of settings.providers ?? []) {
    for (const model of provider.models ?? []) ids.add(model);
  }
  ids.add(settings.modelName);
  ids.add(settings.reviewModelName);
  return Object.fromEntries(
    [...ids]
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => [id, modelMetadataFor(id)])
  );
}

function buildStatus() {
  const sessionFile = runner.getSessionFile();
  const contextUsage = runner.getContextUsage();
  return {
    status: runner.status,
    sessionId: runner.getSessionId(),
    leafId: runner.getLeafId(),
    sessionFile,
    /**
     * Whether the session log exists on disk yet. A draft has a planned path but
     * no file, and the renderer cannot stat, so it must be told rather than left
     * to infer persistence from `/api/sessions` membership — a draft that has
     * only been `/clear`ed is on disk yet still absent from that list.
     */
    sessionPersisted: runner.session.materialized,
    messageCount: runner.getMessages().length,
    model: settings.modelName,
    reviewModel: settings.reviewModelName,
    autoReview: settings.autoReview,
    modelChoices: MODEL_CHOICES,
    modelRoutes: publicRoutes(),
    contextTokens: contextUsage.tokens,
    contextLimit: contextUsage.limit,
    contextPercent: contextUsage.percent,
    reasoningEffort: runner.getModelRoutes().main.reasoningEffort ?? '',
    memoryDir,
    workstation: runner.getWorkstation(),
    emotion: runner.emotion,
    posture: describePosture(runner.emotion)
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(buf);
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Upstream text reaches a browser surface and the server log, so anything that
 * could carry a credential is blanked first: a provider's error envelope echoes
 * the rejected key back (`Invalid key supplied: Bearer sk-live-…`), and V8's
 * `JSON.parse` message embeds a prefix of the offending body.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]'],
  [/\bsk-[A-Za-z0-9_-]{6,}/gi, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/gi, '[redacted]'],
  [/("(?:api[_-]?key|token|secret|password)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2']
];

/**
 * Shortest credential worth blanking by literal value. Nothing this short is a
 * real key, and matching one would shred ordinary prose — a two-character key is
 * a substring of half the English language.
 */
const MIN_LITERAL_SECRET_CHARS = 8;

/**
 * Query-string names whose value is a credential. Same vocabulary as the JSON
 * key alternation in `SECRET_PATTERNS`, so the two agree on what counts as one.
 */
const URL_CREDENTIAL_PARAM = /^(?:api[_-]?key|key|token|access_token|auth|secret|password)$/i;

/** `decodeURIComponent` throws on a malformed `%` escape; a base URL is user input. */
function credentialsInUrl(url: unknown): string[] {
  if (typeof url !== 'string' || url.length === 0) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }

  const found: string[] = [];
  // Userinfo is percent-encoded by the URL parser while the upstream sees the
  // decoded form, so both spellings are matched; `URLSearchParams` values are
  // already decoded. A malformed `%` escape is not decodable at all, so its raw
  // form stands in.
  for (const part of [parsed.username, parsed.password]) {
    if (!part) continue;
    found.push(part);
    try {
      const decoded = decodeURIComponent(part);
      if (decoded !== part) found.push(decoded);
    } catch {
      // Not decodable — the raw form above is the only candidate.
    }
  }
  for (const [name, value] of parsed.searchParams) {
    if (URL_CREDENTIAL_PARAM.test(name)) found.push(value);
  }
  return found;
}

/**
 * Blank the credentials the user has actually configured, BY LITERAL VALUE,
 * before the pattern pass.
 *
 * `SECRET_PATTERNS` above is prefix-based, so it only covers vendors whose keys
 * carry a recognizable shape (`sk-…`, `ghp_…`). This app also ships presets for
 * Groq (`gsk_…`), Google (`AIza…`) and xAI (`xai-…`), and the custom slot takes
 * whatever a relay issued — none of which any pattern matches, so a rejected key
 * from any of them used to travel to the transcript verbatim.
 *
 * The credential a provider echoes back on a 401 is by definition one the user
 * configured, so matching those literals covers every provider — present, future
 * and unlisted — without knowing its key format. This strengthens the pattern
 * pass rather than replacing it: a literal that never appears (a leaked key the
 * user has not stored here) is still caught by shape alone.
 *
 * `extraSecrets` carries request-scoped credentials that are NOT in `settings`
 * yet — the not-yet-saved key a caller hands to `/api/models/fetch`, which this
 * server then sends upstream, so a provider echoing it on a 401 would otherwise
 * write it verbatim into the log. They travel the identical path (same
 * `typeof` check, same `MIN_LITERAL_SECRET_CHARS` floor, same escaping).
 */
function blankConfiguredSecrets(out: string, extraSecrets: readonly unknown[] = []): string {
  // `settings.apiKey` is the credential that belongs to `settings.baseURL` —
  // the two are a pair, resolved together by endpoint — and that endpoint may
  // itself embed one (`?api_key=…`, `token@host`). Neither the endpoint nor any
  // other non-secret field is blanked: replacing it would destroy the part of
  // the message that names the host that failed.
  const configured: unknown[] = [settings.apiKey, ...credentialsInUrl(settings.baseURL), ...extraSecrets];
  // Defensive: a settings file may omit `providers` entirely, or a partial write
  // may leave the field holding something other than a list.
  if (Array.isArray(settings.providers)) {
    for (const provider of settings.providers) {
      configured.push(provider?.apiKey, ...credentialsInUrl(provider?.baseURL));
    }
  }

  for (const value of configured) {
    if (typeof value !== 'string' || value.length < MIN_LITERAL_SECRET_CHARS) continue;
    // An issued key is opaque text, so escape it before it becomes a pattern:
    // `+`, `.`, `$`, `(` are all legitimate characters in one.
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '[redacted]');
  }
  return out;
}

/**
 * Bound for a message on the SSE `error` frame.
 *
 * That frame is the one redaction call site whose output a human reads — it is
 * rendered into the transcript and raised as a desktop notification — whereas
 * the log-only sites below keep the default bound, where clipping is harmless.
 * This constant exists solely to stop a pathological or hostile upstream body
 * from becoming an unbounded notification; it is NOT a length budget for normal
 * prose. A real provider envelope (error `code` + `message` + `param`) runs a few
 * hundred characters, so the previous 300 silently clipped a message the user
 * was meant to read.
 */
const USER_FACING_ERROR_CHARS = 2000;

function redactSecrets(text: string, maxChars = 500, extraSecrets: readonly unknown[] = []): string {
  let out = blankConfiguredSecrets(text, extraSecrets);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out.slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function settingsView() {
  const providersList = (settings.providers && settings.providers.length > 0
    ? settings.providers
    : createDefaultProviders(settings.apiKey, settings.baseURL)
  ).map((p) => ({
    id: p.id,
    name: p.name,
    /**
     * The preset's default label, '' for the custom slot. The renderer shows a
     * dictionary string only while `name` still equals this, so a user's rename
     * wins and no display copy is hardcoded in the SPA.
     */
    presetName: presetNameFor(p.id),
    enabled: p.enabled,
    baseURL: p.baseURL ?? '',
    apiKeyMasked: maskApiKey(p.apiKey || ''),
    apiKeySet: Boolean(p.apiKey && p.apiKey.length > 0),
    models: p.models ?? [],
    description: p.description ?? '',
    helpUrl: p.helpUrl ?? '',
    custom: Boolean(p.custom)
  }));

  return {
    apiKeyMasked: maskApiKey(settings.apiKey),
    apiKeySet: settings.apiKey.length > 0,
    baseURL: settings.baseURL,
    modelName: settings.modelName,
    reviewModelName: settings.reviewModelName,
    autoReview: settings.autoReview,
    language: settings.language,
    theme: settings.theme,
    reasoningEffort: settings.reasoningEffort,
    reasoningEffortEffective: runner.getModelRoutes().main.reasoningEffort ?? '',
    reasoningSupported: supportsReasoningEffort(settings.modelName),
    modelChoices: MODEL_CHOICES,
    /**
     * Capability metadata (vision / tools / context window) per model id. The
     * renderer needs the window to label a model picker and the usage meter to
     * divide by the right number, and neither can compute it: the numbers are
     * per-provider facts, not derivable from the id.
     */
    modelMetadata: modelMetadataView(),
    activeProviderId: settings.activeProviderId || (providersList[0]?.id ?? 'openai'),
    providers: providersList
  };
}

/**
 * Merge a settings patch, persist it, and rebuild the runner so new credentials
 * and models take effect immediately. The active session is re-opened by path
 * so the conversation survives the swap.
 */
function applySettings(patch: Record<string, unknown>): { restarted: boolean; sessionId: string } {
  const next: UiSettings = { ...settings };

  if (typeof patch.apiKey === 'string' && patch.apiKey.length > 0) next.apiKey = patch.apiKey.trim();
  if (typeof patch.baseURL === 'string') next.baseURL = patch.baseURL.trim();
  if (typeof patch.modelName === 'string' && patch.modelName.trim()) next.modelName = patch.modelName.trim();
  if (typeof patch.reviewModelName === 'string' && patch.reviewModelName.trim()) {
    next.reviewModelName = patch.reviewModelName.trim();
  }
  if (typeof patch.autoReview === 'boolean') next.autoReview = patch.autoReview;
  if (typeof patch.reasoningEffort === 'string') {
    const raw = patch.reasoningEffort.trim();
    // '' is the explicit "derive" choice; anything else must name a level.
    const parsed = raw === '' ? '' : parseReasoningEffort(raw);
    if (parsed === undefined) {
      throw new Error(`Invalid reasoningEffort '${raw}'. Expected one of: low, medium, high (or '' to derive).`);
    }
    next.reasoningEffort = parsed;
  }
  if (patch.language !== undefined) {
    const raw = typeof patch.language === 'string' ? patch.language.trim() : String(patch.language);
    const parsed = parseLanguage(raw);
    if (parsed === undefined) {
      throw new Error(`Invalid language '${raw}'. Expected one of: ${UI_LANGUAGES.join(', ')}.`);
    }
    // Deliberately absent from `runnerChanged`: language is presentation only,
    // so switching it must not swap the runner and drop the live session.
    next.language = parsed;
  }
  if (patch.theme !== undefined) {
    const raw = typeof patch.theme === 'string' ? patch.theme.trim() : String(patch.theme);
    const parsed = parseTheme(raw);
    if (parsed === undefined) {
      throw new Error(`Invalid theme '${raw}'. Expected one of: ${THEMES.join(', ')}.`);
    }
    // Same as `language`: absent from `runnerChanged`, so an appearance switch
    // never swaps the runner and never drops the live session.
    next.theme = parsed;
  }
  if (typeof patch.activeProviderId === 'string' && patch.activeProviderId.trim()) {
    next.activeProviderId = patch.activeProviderId.trim();
  }

  if (Array.isArray(patch.providers)) {
    const existing = next.providers || createDefaultProviders(next.apiKey, next.baseURL);
    const previousById: Record<string, ProviderConfig> = {};
    for (const provider of existing) previousById[provider.id] = provider;

    const updated: ProviderConfig[] = [];
    for (const rawItem of patch.providers) {
      if (!rawItem || typeof rawItem !== 'object') continue;
      const item = rawItem as Record<string, unknown>;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id) continue;
      const prev = previousById[id];
      let itemKey = typeof item.apiKey === 'string' ? item.apiKey.trim() : '';
      // The view only ever sends a masked stub, so an empty or masked value
      // means "unchanged" and must not clobber the stored credential.
      if (!itemKey || itemKey.includes('••••')) itemKey = prev?.apiKey ?? '';
      updated.push({
        id,
        // No `?? id` fallback: an unnamed provider is legitimate (a fresh custom
        // slot), and substituting the id would pin a machine identifier into the
        // UI instead of letting the renderer show the localized default.
        name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : (prev?.name ?? ''),
        enabled: typeof item.enabled === 'boolean' ? item.enabled : (prev?.enabled ?? false),
        apiKey: itemKey,
        baseURL: typeof item.baseURL === 'string' ? item.baseURL.trim() : (prev?.baseURL ?? ''),
        models: Array.isArray(item.models)
          ? item.models.map((model) => String(model).trim()).filter(Boolean)
          : (prev?.models ?? []),
        description: typeof item.description === 'string' ? item.description : (prev?.description ?? ''),
        helpUrl: typeof item.helpUrl === 'string' ? item.helpUrl : (prev?.helpUrl ?? ''),
        custom: typeof item.custom === 'boolean' ? item.custom : (prev?.custom ?? false)
      });
    }
    next.providers = updated;
  }

  // Exactly one provider is active, and the top-level credential fields are a
  // pure PROJECTION of it — always assigned, never merged with whatever the
  // patch carried. That is what keeps the pair coherent: switching to a provider
  // with no key of its own legitimately leaves the app unconfigured (an explicit
  // auth failure) rather than silently sending the previous provider's key to the
  // new provider's endpoint.
  //
  // Each provider entry keeps its OWN credential, so nothing is lost: switching
  // back restores the key. Do not "helpfully" write the active key back into the
  // active entry — that would copy one secret into several entries and leave a
  // stale copy silently in force after the user rotates it on another one.
  //
  // Gated on the patch touching the provider surface, so a legacy caller posting
  // just `{ baseURL }` behaves exactly as before. Inside the gate there is no
  // escape hatch: a top-level apiKey/baseURL in the same patch is overwritten by
  // the active provider, because two sources for one credential is precisely the
  // ambiguity this surface exists to remove.
  if (patch.providers !== undefined || patch.activeProviderId !== undefined) {
    const providers = next.providers ?? createDefaultProviders(next.apiKey, next.baseURL);
    next.providers = providers;
    // A patch may name an id no entry carries — the user deleted the active
    // provider, or the renderer sent a stale one. Re-point at the first survivor,
    // or the id dangles: the UI highlights nothing and the runner keeps the
    // previous provider's credentials in force.
    if (!providers.some((provider) => provider.id === next.activeProviderId)) {
      next.activeProviderId = providers[0]?.id ?? '';
    }
    for (const provider of providers) {
      provider.enabled = provider.id === next.activeProviderId;
    }
    const activeProvider = providers.find((provider) => provider.id === next.activeProviderId);
    next.apiKey = activeProvider?.apiKey ?? '';
    next.baseURL = activeProvider?.baseURL ?? '';
  }

  const runnerChanged =
    next.apiKey !== settings.apiKey ||
    next.baseURL !== settings.baseURL ||
    next.modelName !== settings.modelName ||
    next.reviewModelName !== settings.reviewModelName ||
    next.autoReview !== settings.autoReview ||
    next.reasoningEffort !== settings.reasoningEffort;

  settings = next;
  persistSettings(settings);

  if (!runnerChanged) {
    return { restarted: false, sessionId: runner.getSessionId() };
  }

  const activeSession = runner.getSessionFile();
  // A draft has no file on disk yet, so `resolveSessionFile` cannot find it and
  // the rebuild would silently start a different session. Carry the plan
  // forward as a fresh draft instead — an unsent draft holds no messages, so
  // nothing is lost and the new session still materializes on its first one.
  const draft = !runner.session.materialized;
  const carriedEmotion = runner.emotion;
  runner.close();
  runner = new AgentRunner(
    runnerOptions(draft ? undefined : activeSession ?? undefined, undefined, draft)
  );
  runner.emotion = carriedEmotion;

  return { restarted: true, sessionId: runner.getSessionId() };
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

const API_METHODS: Record<string, string[]> = {
  '/api/status': ['GET'],
  '/api/models': ['GET'],
  '/api/models/fetch': ['POST'],
  '/api/model': ['POST'],
  '/api/settings': ['GET', 'POST'],
  '/api/sessions': ['GET'],
  '/api/sessions/new': ['POST'],
  '/api/sessions/load': ['POST'],
  '/api/messages': ['GET'],
  '/api/clear': ['POST'],
  '/api/history': ['GET'],
  '/api/abort': ['POST'],
  '/api/approve': ['POST'],
  '/api/shutdown': ['POST'],
  '/api/chat': ['POST']
};

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const allowed = API_METHODS[pathname];

  if (allowed && !allowed.includes(method)) {
    res.setHeader('Allow', allowed.join(', '));
    sendError(res, 405, `Method not allowed: ${method} ${pathname} (allowed: ${allowed.join(', ')})`);
    return true;
  }

  if (pathname === '/api/status' && method === 'GET') {
    sendJson(res, 200, buildStatus());
    return true;
  }

  if (pathname === '/api/models' && method === 'GET') {
    sendJson(res, 200, publicRoutes());
    return true;
  }
  if (pathname === '/api/models/fetch' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, errorMessage(err));
      return true;
    }

    const endpoint = typeof body.baseURL === 'string' && body.baseURL.trim()
      ? body.baseURL.trim()
      : settings.baseURL || 'https://api.openai.com/v1';

    let targetKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (targetKey.includes('••••')) targetKey = '';

    // A stored credential is resolved BY ENDPOINT, never by a separate id hint:
    // the key used is the one belonging to whichever entry owns this exact URL.
    // Asking "is this URL known?" and then picking a key from a *different*
    // provider would send one provider's secret to another provider's host —
    // exactly the exfiltration this guard exists to prevent. The console is
    // unauthenticated, so a caller-supplied baseURL must never be able to draw
    // out a credential it does not own.
    //
    // An unknown endpoint simply gets an anonymous probe: there is no stored key
    // for it, so nothing can leak. That is also what makes a keyless local
    // endpoint (Ollama, a bare relay) work before it has ever been saved.
    if (!targetKey) {
      const normalize = (value: string): string => value.replace(/\/+$/, '').toLowerCase();
      const wanted = normalize(endpoint);
      const owner = (settings.providers ?? []).find((p) => p.baseURL && normalize(p.baseURL) === wanted);
      if (owner) {
        targetKey = owner.apiKey;
      } else if (settings.baseURL && normalize(settings.baseURL) === wanted) {
        targetKey = settings.apiKey;
      }
    }

    const modelsUrl = endpoint.replace(/\/+$/, '') + '/models';
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json'
      };
      if (targetKey) {
        headers['Authorization'] = `Bearer ${targetKey}`;
      }
      const resp = await fetch(modelsUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10000)
      });
      if (!resp.ok) {
        console.error(`[models/fetch] ${modelsUrl} -> HTTP ${resp.status}: ${redactSecrets(await resp.text(), 500, [targetKey])}`);
        sendJson(res, 200, { ok: false, error: `HTTP ${resp.status}`, models: [] });
        return true;
      }
      const data = (await resp.json()) as { data?: Array<{ id?: string }> };
      const rawList = Array.isArray(data?.data) ? data.data : [];
      const models = rawList
        .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
        .filter(Boolean);
      sendJson(res, 200, { ok: true, models });
      return true;
    } catch (err) {
      // A non-JSON 200 body surfaces here as a `JSON.parse` error whose message
      // quotes the raw body, so the detail is logged redacted and never returned.
      console.error(`[models/fetch] ${modelsUrl} failed: ${redactSecrets(errorMessage(err), 300, [targetKey])}`);
      sendJson(res, 200, { ok: false, error: 'Fetch failed', models: [] });
      return true;
    }
  }

  if (pathname === '/api/model' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, errorMessage(err));
      return true;
    }

    const roleInput = typeof body.role === 'string' ? body.role : 'main';
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      sendError(res, 400, 'Missing required field: model');
      return true;
    }
    const role = MODEL_ROLES.find((candidate) => candidate === roleInput);
    if (!role) {
      sendError(res, 400, `Unknown model role '${roleInput}'. Expected one of: ${MODEL_ROLES.join(', ')}`);
      return true;
    }

    // Runtime switch: takes effect on the next turn, never disturbs a running one.
    runner.setModel(role, { model });

    // Mirror into persisted settings so the selection survives a restart. This
    // writes the file only — the runner is NOT rebuilt, so the active session
    // and in-flight context are untouched.
    const nextSettings = { ...settings };
    if (role === 'main') nextSettings.modelName = model;
    if (role === 'review') nextSettings.reviewModelName = model;
    settings = nextSettings;
    persistSettings(settings);

    sendJson(res, 200, { role, model, routes: publicRoutes() });
    return true;
  }

  if (pathname === '/api/settings' && method === 'GET') {
    sendJson(res, 200, settingsView());
    return true;
  }

  if (pathname === '/api/settings' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, errorMessage(err));
      return true;
    }

    // `language` and `theme` are presentation-only and never touch the runner,
    // so a patch that carries nothing else must not be gated on an idle agent —
    // otherwise switching the interface language or the appearance mid-turn
    // fails with a 409 and the UI visibly snaps back. Any other key still
    // requires an idle runner.
    const presentationOnly = Object.keys(body).every((key) => key === 'language' || key === 'theme');

    if (!presentationOnly && runner.status !== 'idle') {
      sendError(res, 409, 'Cannot apply settings while the agent is busy. Abort the turn first.');
      return true;
    }

    // Apply first: `settingsView()` must observe the new state, not the old.
    let applied: { restarted: boolean; sessionId: string };
    try {
      applied = applySettings(body);
    } catch (err) {
      sendError(res, 400, errorMessage(err));
      return true;
    }
    sendJson(res, 200, { ...settingsView(), ...applied });
    return true;
  }

  if (pathname === '/api/sessions' && method === 'GET') {
    const sessions = runner.listSessions().map((session: SessionDescriptor) => ({
      id: session.id,
      title: session.title ?? '',
      timestamp: session.timestamp,
      cwd: session.cwd,
      filePath: session.filePath,
      mtimeMs: session.mtimeMs,
      active: session.id === runner.getSessionId()
    }));
    sendJson(res, 200, sessions);
    return true;
  }

  if (pathname === '/api/messages' && method === 'GET') {
    sendJson(res, 200, serializeMessages(runner.getMessages()));
    return true;
  }

  if (pathname === '/api/sessions/new' && method === 'POST') {
    runner.createSession();
    sendJson(res, 200, { status: buildStatus(), messages: serializeMessages(runner.getMessages()) });
    return true;
  }

  if (pathname === '/api/sessions/load' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, errorMessage(err));
      return true;
    }

    const reference = typeof body.sessionIdOrPath === 'string' ? body.sessionIdOrPath.trim() : '';
    if (!reference) {
      sendError(res, 400, 'Missing required field: sessionIdOrPath');
      return true;
    }

    try {
      runner.loadSession(reference);
    } catch (err) {
      // The client gets a sentence built from the reference it supplied, never
      // the core message, so no host-filesystem detail can leak. The core error
      // is operator detail that may change (as of runner.ts:501 it no longer
      // names the workspace), so it is logged redacted rather than relayed.
      console.error(`[server] session load failed: ${redactSecrets(errorMessage(err), 300)}`);
      sendError(res, 404, `Session '${reference}' not found.`);
      return true;
    }

    sendJson(res, 200, { status: buildStatus(), messages: serializeMessages(runner.getMessages()) });
    return true;
  }

  if (pathname === '/api/clear' && method === 'POST') {
    runner.reset();
    sendJson(res, 200, { status: buildStatus(), messages: serializeMessages(runner.getMessages()) });
    return true;
  }

  if (pathname === '/api/history' && method === 'GET') {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const query = url.searchParams.get('q') ?? undefined;
    const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20;
    sendJson(res, 200, runner.getHistory(query, limit));
    return true;
  }

  if (pathname === '/api/abort' && method === 'POST') {
    resolvePendingApprovals(false);
    runner.abort();
    sendJson(res, 200, { ok: true, status: runner.status });
    return true;
  }

  if (pathname === '/api/approve' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, errorMessage(err));
      return true;
    }

    const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : '';
    if (!toolCallId) {
      sendError(res, 400, 'Missing required field: toolCallId');
      return true;
    }

    const resolve = pendingApprovals.get(toolCallId);
    if (!resolve) {
      sendError(res, 404, `No pending approval for tool call '${toolCallId}'`);
      return true;
    }

    pendingApprovals.delete(toolCallId);
    const approved = body.approved === true;
    recordApprovalWait(toolCallId);
    resolve(approved);
    sendJson(res, 200, { ok: true, toolCallId, approved });
    return true;
  }

  if (pathname === '/api/shutdown' && method === 'POST') {
    sendJson(res, 200, { ok: true });
    // Grace period lets the response flush before the socket closes.
    setTimeout(() => shutdownHook?.(), 60).unref();
    return true;
  }

  if (pathname === '/api/chat' && method === 'POST') {
    await handleChat(req, res);
    return true;
  }

  if (pathname.startsWith('/api/')) {
    sendError(res, 404, `Unknown API route: ${method} ${pathname}`);
    return true;
  }

  return false;
}

/**
 * One agent turn streamed over SSE.
 *
 * `EventSource` cannot POST, so the browser consumes this with `fetch` +
 * `ReadableStream` and parses the `data:` frames itself.
 */
async function handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendError(res, 400, errorMessage(err));
    return;
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    sendError(res, 400, 'Missing required field: prompt');
    return;
  }

  // Per-turn pin: overrides the main route for this turn only, never persisted.
  const turnModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;

  if (runner.status !== 'idle') {
    sendError(res, 409, 'Agent is busy. Abort or wait for the current turn.');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  let closed = false;
  let settled = false;
  let errorSent = false;

  const write = (payload: unknown): void => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15_000);
  heartbeat.unref();

  // Client hang-up tears the turn down: pending approvals resolve false and the
  // abort signal kills the tool process tree, so the turn can never hang.
  res.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    approvalSink = null;
    resolvePendingApprovals(false);
    if (!settled) runner.abort();
  });

  /**
   * Tool durations are measured here: the core loop reports name + outcome only.
   * The approval maps are module-level because the permission gate is built once
   * at runner construction; only one turn can run at a time, so they are reset
   * at the start of each turn.
   */
  const toolStarts = new Map<string, number[]>();
  approvalWaits.clear();
  approvalStartedAt.clear();
  approvalToolNames.clear();

  const runTurn = (
    target: AgentRunner,
    turnPrompt: string,
    phase: string,
    modelOverride?: string
  ): Promise<string> => {
    // Resolved once per turn, from the same runner the turn runs on: the
    // credential that runner will actually send, not the one settings imply.
    const secrets = resolvedCredentials(target);
    const callbacks: RunnerCallbacks = {
      onStatusChange: (status) => write({ type: 'status', status }),
      onStepStart: (step) => write({ type: 'step', step, phase }),
      onChunk: (text) => write({ type: 'chunk', text, phase }),
      onReasoning: (text) => write({ type: 'reasoning', text, phase }),
      onToolCall: (name, args) => {
        const stack = toolStarts.get(name) ?? [];
        stack.push(Date.now());
        toolStarts.set(name, stack);
        write({ type: 'tool_call', name, args, phase });
      },
      onToolResult: (name, result, isError) => {
        const startedAt = toolStarts.get(name)?.shift();
        const waited = approvalWaits.get(name)?.shift() ?? 0;
        const elapsed = startedAt ? Math.max(0, Date.now() - startedAt - waited) : 0;
        write({
          type: 'tool_result',
          name,
          result,
          isError: isError === true,
          durationMs: elapsed,
          approvalWaitMs: waited,
          phase
        });
      },
      onError: (err) => {
        errorSent = true;
        // A failed model call surfaces the provider's own error envelope, which
        // echoes the rejected credential back. This frame is rendered into the
        // transcript and raised as a desktop notification, so it takes the same
        // redaction as every other upstream-derived string on this surface.
        write({ type: 'error', message: redactSecrets(err.message, USER_FACING_ERROR_CHARS, secrets), phase });
      }
    };
    return target.run(turnPrompt, callbacks, modelOverride ? { model: modelOverride } : {});
  };

  const finish = (finalText: string): void => {
    // Read the meter at the end of the turn rather than reusing a value from
    // `buildStatus()`: the last step's usage is what the turn's final context
    // size is, and it only exists once the step has reported it.
    const contextUsage = runner.getContextUsage();
    write({
      type: 'done',
      finalText,
      sessionId: runner.getSessionId(),
      leafId: runner.getLeafId(),
      messageCount: runner.getMessages().length,
      contextTokens: contextUsage.tokens,
      contextLimit: contextUsage.limit,
      contextPercent: contextUsage.percent,
      emotion: runner.emotion,
      posture: describePosture(runner.emotion)
    });
  };

  approvalSink = write;

  try {
    const finalText = await runTurn(runner, prompt, 'main', turnModel);
    settled = true;
    finish(finalText);
  } catch (err) {
    settled = true;
    // The same resolved credentials as the `onError` frame above: this path
    // catches a failure raised outside the model call, which can still carry the
    // provider's envelope.
    if (!errorSent) {
      write({
        type: 'error',
        message: redactSecrets(errorMessage(err), USER_FACING_ERROR_CHARS, resolvedCredentials(runner))
      });
    }
    finish('');
  } finally {
    approvalSink = null;
    resolvePendingApprovals(false);
    clearInterval(heartbeat);
    if (!closed) res.end();
  }
}

// ---------------------------------------------------------------------------
// Static assets (SPA)
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function serveFile(res: http.ServerResponse, filePath: string): boolean {
  let data: Buffer;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return false;
  }

  res.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache'
  });
  res.end(data);
  return true;
}

function handleStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  const candidate = path.resolve(PUBLIC_DIR, relative);

  // Traversal guard: only paths that stay inside PUBLIC_DIR are eligible.
  if (candidate.startsWith(PUBLIC_DIR + path.sep)) {
    try {
      if (fs.statSync(candidate).isFile() && serveFile(res, candidate)) return;
    } catch {
      // Fall through to the SPA fallback below.
    }
  }

  // SPA fallback: every unmatched navigation route renders the shell.
  if (pathname === '/' || (req.headers.accept ?? '').includes('text/html')) {
    if (serveFile(res, path.join(PUBLIC_DIR, 'index.html'))) return;
  }

  sendError(res, 404, `Not found: ${pathname}`);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * Boot the SuperIU web shell.
 *
 * Importing this module has no side effects; the HTTP server only starts here,
 * so an embedding host (e.g. an Electron shell) can pick its own port, keep the
 * banner quiet, and shut everything down deterministically.
 */
export async function startServer(options: StartServerOptions = {}): Promise<ServerHandle> {
  const port = options.port ?? Number.parseInt(process.env.PORT ?? '3000', 10);
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const workspaceDir = path.resolve(options.workspaceDir ?? process.cwd());

  PUBLIC_DIR = options.publicDir ? path.resolve(options.publicDir) : path.resolve(HERE, '..', 'public');
  SETTINGS_FILE = options.settingsFile
    ? path.resolve(options.settingsFile)
    : path.join(workspaceDir, '.myagent', 'ui-settings.json');

  settings = loadSettings();
  memoryDir = await resolveMemoryDir();
  runner = new AgentRunner(runnerOptions());

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    void (async () => {
      try {
        if (await handleApi(req, res, pathname)) return;
        if (req.method === 'GET' || req.method === 'HEAD') {
          handleStatic(req, res, pathname);
          return;
        }
        sendError(res, 405, `Method not allowed: ${req.method} ${pathname}`);
      } catch (err) {
        // The detail is diagnostic, not copy: it can carry an absolute path and
        // an errno straight from the filesystem. Log it (redacted) and hand the
        // client a stable sentence instead, so the toast cannot read like a
        // stack trace.
        console.error(`[server] unhandled request error: ${redactSecrets(errorMessage(err), 300)}`);
        if (!res.headersSent) {
          sendError(res, 500, 'Internal server error. Check the server log for details.');
        } else {
          res.end();
        }
      }
    })();
  });

  const listening = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });

  if (!options.quiet) {
    const workstation = runner.getWorkstation();
    console.log('=== SuperIU Web UI (@agent/ui) ===');
    console.log(`  Listening:   http://${host}:${listening}`);
    console.log(`  Main model:  ${settings.modelName}`);
    console.log(`  Language:    ${settings.language}`);
    console.log(`  Theme:       ${settings.theme}`);
    console.log(`  Tool model:  ${settings.reviewModelName} (autoReview ${settings.autoReview ? 'on' : 'off'})`);
    console.log(`  Session:     ${runner.getSessionId()}`);
    // A boot with no resumable session starts a draft, so the path printed here
    // may not exist yet; do not present it as an existing log.
    console.log(
      `  Log:         ${runner.getSessionFile() ?? '(in-memory)'}` +
        (runner.session.materialized ? '' : ' (not written yet)')
    );
    console.log(`  Memory:      ${memoryDir}`);
    console.log(`  Settings:    ${SETTINGS_FILE}`);
    console.log(`  Workspace:   ${workstation.cwd}`);
    console.log(`  Assets:      ${PUBLIC_DIR}`);
    console.log('');
  }

  let closing: Promise<void> | null = null;

  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      resolvePendingApprovals(false);
      server.close(() => {
        runner.close();
        resolve();
      });
      // Idle keep-alive sockets would otherwise hold the close callback open.
      server.closeAllConnections?.();
    });
    return closing;
  };

  shutdownHook = () => void close();
  return {
    port: listening,
    host,
    url: `http://${host}:${listening}`,
    language: settings.language,
    theme: settings.theme,
    close
  };
}

// Standalone entry point: `node dist/server.js` (used by `pnpm ui`).
const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const handle = await startServer();
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[${signal}] Shutting down SuperIU Web UI...`);
    void handle.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
