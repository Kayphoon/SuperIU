import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentRunner,
  DEFAULT_MAIN_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REVIEW_MODEL,
  MODEL_ROLES,
  formatContextLimit,
  getEmotionPromptModifier,
  modelMetadataFor,
  parseReasoningEffort,
  resolveMemoryDir,
  supportsReasoningEffort,
  type ContextMessage,
  type EmotionState,
  type McpServerConfig,
  type ModelMetadata,
  type ModelRole,
  type ModelRoute,
  type ReasoningEffort,
  type RunnerCallbacks,
  type SessionDescriptor,
  type ToolCallItem
} from '@agent/core';
import type { ReviewResult } from '@agent/core';
import { AuthLayer, authModeFromEnv } from './auth/middleware.js';
import { GatewayServer, DeviceRegistry, EventHub } from './gateway/index.js';
import type { GatewayRunner } from './gateway/index.js';

// Re-export the gateway surface so `@agent/ui` is the single import a host needs
// to boot both the web shell and the WebSocket gateway.
export { GatewayServer, DeviceRegistry, EventHub } from './gateway/index.js';
export type {
  GatewayServerOptions,
  GatewayRunner,
  ConnectedClient,
  DeviceRegistryOptions,
  EventHubOptions
} from './gateway/index.js';
export { TargetDeviceOfflineError, RpcTimeoutError, RemoteRpcError } from './gateway/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 1_000_000;

export interface StartServerOptions {
  /** TCP port. `0` selects an ephemeral port. Defaults to `PORT` env or 3000. */
  port?: number;
  /** Bind address. Defaults to `HOST` env or 127.0.0.1. */
  host?: string;
  /** Workspace root owning `.superiu/` (sessions, history, settings). Defaults to cwd. */
  workspaceDir?: string;
  /** Directory holding `index.html` / `notifications.js`. Defaults to the package's `public/`. */
  publicDir?: string;
  /** Settings JSON path. Defaults to `<workspaceDir>/.superiu/ui-settings.json`. */
  settingsFile?: string;
  /** Suppress the startup banner. */
  quiet?: boolean;
  /**
   * WebSocket path the VPS Gateway binds to on the same HTTP server. Defaults
   * to `/ws`; pass `null` to boot the web shell without a gateway.
   */
  gatewayPath?: string | null;
  /**
   * Pre-shared token clients must present during the gateway handshake.
   * Defaults to `SUPERIU_GATEWAY_TOKEN`; when neither is set the gateway runs in
   * open development mode.
   */
  gatewayToken?: string;
  /** Build version to report via `/api/status`. Absent in a plain `tsc` dev run. */
  version?: string;
  /**
   * When set, listen on this Unix domain socket instead of TCP; `port`/`host`
   * are ignored. A stale socket file at the path is cleared before binding and
   * the socket is created `0600`.
   */
  socketPath?: string;
  /**
   * Force pairing authentication on (`true`) or off (`false`). When omitted,
   * `SUPERIU_WEB_AUTH` decides, falling back to AUTO: on when the bind host is
   * not loopback, or when the workspace's `.superiu/pairing.json` holds a key or
   * code. Exposed so tests and embedders can pin the mode.
   */
  webAuth?: boolean;
  /**
   * MCP config file the runner's manager loads at boot. Defaults to
   * `~/.superiu/mcp.json`; pass `null` to disable MCP config-file loading
   * entirely (programmatic-only hosts, tests).
   */
  mcpConfigPath?: string | null;
  /** Optional lifecycle hooks to drive the `/api/update` routes. */
  updateHooks?: UpdateHooks;
}

export interface UpdateHooks {
  onCheckUpdate?: () => Promise<{
    current: string;
    latest?: string;
    hasUpdate: boolean;
    canUpdate?: boolean;
    error?: string;
  }>;
  onApplyUpdate?: () => Promise<{
    updated: boolean;
    current: string;
    latest?: string;
  }>;
}

export interface ServerHandle {
  /** Resolved port — the real one when `0` was requested; `0` in socket mode. */
  port: number;
  host: string;
  url: string;
  /** Absolute path when listening on a Unix domain socket; absent in TCP mode. */
  socketPath?: string;
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
  /**
   * The live VPS Gateway, when one was booted. `undefined` only when
   * `gatewayPath: null` was requested. Exposed so an embedder can inspect
   * connected devices or invoke {@link GatewayServer.callClientRpc}.
   */
  gateway?: GatewayServer;
  /** WebSocket URL clients should connect to, when a gateway was booted. */
  gatewayUrl?: string;
  /**
   * Whether pairing authentication is enforced. Reflects the resolved mode at
   * boot; AUTO can still flip on later if a key or code is minted offline.
   */
  pairingEnabled: boolean;
  /**
   * Mint a one-time pairing code for programmatic use (the `superiu-server pair`
   * command). `advertiseUrl` is the public origin to build the connect URL from;
   * when omitted the URL is a relative path.
   */
  mintConnectCode(
    advertiseUrl?: string,
    label?: string
  ): { code: string; url: string; expiresAt: string; label?: string };
  /** True when no turn is running and none is waiting on a human approval. */
  isIdle(): boolean;
  /** Stop accepting new turns so an in-flight turn can finish before a self-update. */
  setDraining(draining: boolean): void;
  /** Install or replace update hooks backing `/api/update`. */
  setUpdateHooks(hooks: UpdateHooks): void;
  /** Idempotent: resolves pending approvals, closes the HTTP server and the agent runner. */
  close(): Promise<void>;
}

// Resolved by startServer so the module can be imported without side effects.
let PUBLIC_DIR = path.resolve(HERE, '..', 'public');
let SETTINGS_FILE = path.join(process.cwd(), '.superiu', 'ui-settings.json');

/**
 * The shipped model-id catalog: suggestions, never a selection.
 *
 * Nothing here is "configured" until the user picks it. The settings pane's
 * model grid offers these ids as `#model-choices` datalist suggestions, and the
 * capability/reasoning metadata maps cover them so a suggestion can be labeled
 * before it is ever chosen. No select and no pill renders from this list: an
 * install with nothing configured must show no model anywhere, which is why the
 * lists the API serves come from `configuredModelIds()` and only
 * `settingsView().knownModels` exposes this catalog.
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

/** Reasoning levels, weakest first — the canonical order of a `ModelOptionConfig.efforts` list. */
const REASONING_LEVELS: readonly ReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
];

/** True for a JSON object literal: not null, not an array, not a primitive. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a per-model configuration map, reporting why each entry was rejected.
 *
 * One scan serves both callers, because their tolerance differs only in what they
 * do with `errors`: `loadSettings` keeps the valid entries — a hand-edited file
 * must never make the server unstartable — while `applySettings` refuses the
 * whole patch so a malformed write cannot half-apply. Copying the rules per
 * caller is exactly how the two would drift apart.
 *
 * `efforts` is normalized to the canonical order and de-duplicated, so the same
 * list written two ways compares equal under `JSON.stringify` — which
 * `applySettings` uses to decide whether the runner has to be rebuilt. An EMPTY
 * list is meaningful and preserved: it is the explicit "this model refuses
 * `reasoning_effort`" answer, distinct from the absent field ("ask the built-in
 * detector").
 */
function scanModelConfigs(value: unknown): { configs: Record<string, ModelOptionConfig>; errors: string[] } {
  const configs: Record<string, ModelOptionConfig> = {};
  const errors: string[] = [];
  if (value === undefined || value === null) return { configs, errors };
  if (!isPlainObject(value)) {
    errors.push('expected an object of { modelId: { enabled?, efforts? } }');
    return { configs, errors };
  }

  for (const [rawId, rawEntry] of Object.entries(value)) {
    const id = rawId.trim();
    if (!id) {
      errors.push('a model id is empty');
      continue;
    }
    if (!isPlainObject(rawEntry)) {
      errors.push(`'${id}' must be an object`);
      continue;
    }
    if (rawEntry.enabled !== undefined && typeof rawEntry.enabled !== 'boolean') {
      errors.push(`'${id}'.enabled must be a boolean`);
      continue;
    }
    let contextLimit: number | undefined;
    if (rawEntry.contextLimit !== undefined) {
      const rawLimit = Number(rawEntry.contextLimit);
      if (!Number.isInteger(rawLimit) || rawLimit <= 0) {
        errors.push(`'${id}'.contextLimit must be a positive integer`);
        continue;
      }
      contextLimit = rawLimit;
    }
    let efforts: ReasoningEffort[] | undefined;
    const rawEfforts = rawEntry.efforts;
    if (rawEfforts !== undefined) {
      if (
        !Array.isArray(rawEfforts) ||
        rawEfforts.some((level) => !REASONING_LEVELS.includes(level as ReasoningEffort))
      ) {
        errors.push(`'${id}'.efforts must be an array of: ${REASONING_LEVELS.join(', ')}`);
        continue;
      }
      efforts = REASONING_LEVELS.filter((level) => rawEfforts.includes(level));
    }
    configs[id] = {
      ...(rawEntry.enabled === undefined ? {} : { enabled: rawEntry.enabled }),
      ...(contextLimit === undefined ? {} : { contextLimit }),
      ...(efforts === undefined ? {} : { efforts })
    };
  }
  return { configs, errors };
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
  /** Protocol format: 'openai' | 'anthropic' | 'google'. Defaults to 'openai' or inferred from id/baseURL. */
  apiType?: string;
}
export interface ModelOptionConfig {
  /** false hides the model from the composer picker. Absent = enabled. */
  enabled?: boolean;
  /**
   * Reasoning levels this model accepts. Present = authoritative (empty =
   * refuses the parameter). Absent = fall back to the built-in detector.
   */
  efforts?: ReasoningEffort[];
  /** Custom context window ceiling in tokens. Absent = built-in metadata. */
  contextLimit?: number;
}

/**
 * Built-in provider templates, in display order. `name` here is the provider's
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
 * A template is a starting point the renderer offers when the user adds a
 * provider; it is never auto-seeded into settings, so an install with nothing
 * configured starts with no provider rows at all.
 */
export interface ProviderTemplate {
  id: string;
  name: string;
  baseURL: string;
  helpUrl: string;
  apiType?: string;
}

export function defaultApiTypeFor(id: string, baseURL?: string): string {
  if (id.startsWith('anthropic')) return 'anthropic';
  if (id.startsWith('gemini') || id.startsWith('google')) {
    if (baseURL && /\/openai\/?$/i.test(baseURL)) return 'openai';
    return 'google';
  }
  if (id.includes('response') || (baseURL && /\/responses\/?$/i.test(baseURL))) {
    return 'responses';
  }
  return 'openai';
}

export const PROVIDER_TEMPLATES: ReadonlyArray<ProviderTemplate> = [
  { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', helpUrl: 'https://platform.openai.com/api-keys', apiType: 'openai' },
  { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', helpUrl: 'https://platform.deepseek.com/api_keys', apiType: 'openai' },
  { id: 'gemini', name: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', helpUrl: 'https://aistudio.google.com/app/apikey', apiType: 'openai' },
  { id: 'anthropic', name: 'Anthropic', baseURL: 'https://api.anthropic.com/v1', helpUrl: 'https://console.anthropic.com/settings/keys', apiType: 'anthropic' },
  { id: 'ollama', name: 'Ollama', baseURL: 'http://localhost:11434/v1', helpUrl: 'https://ollama.com', apiType: 'openai' },
  { id: 'openrouter', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', helpUrl: 'https://openrouter.ai/keys', apiType: 'openai' }
];

/** The custom slot's id; it has no preset row and is the user's to name. */
const CUSTOM_PROVIDER_ID = 'custom';

/**
 * The model catalog each preset shipped in the CURRENT release, keyed by
 * provider id. It is never written into a provider — a fresh install seeds no
 * models, so nothing is configured until the user picks one — and survives as
 * the fingerprint that recognizes an app-written list: a stored list
 * byte-identical to this one was written by a default, not chosen by the user,
 * and `migratePresetModels()` clears it.
 *
 * As a catalog it is a short, representative slice of what each vendor
 * currently serves — not an exhaustive one — so every entry must still be a live
 * id from that vendor's own model list. A retired id here is worse than a
 * missing one: it is offered in the model grid and cannot succeed when picked.
 */
const SHIPPED_PRESET_MODELS: Readonly<Record<string, readonly string[]>> = {
  openai: ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-4o', 'gpt-4.1'],
  anthropic: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5'],
  gemini: ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  deepseek: ['deepseek-flash', 'deepseek-v4-pro']
};

/**
 * Model lists each preset shipped BEFORE the current catalog, keyed by provider
 * id — the fingerprints of a settings file this app wrote itself.
 *
 * An existing `ui-settings.json` keeps whatever lists it was written with.
 * Those lists were never the user's: an install with nothing configured still
 * carried a full catalog of ids the user never chose, and the model picker
 * offered them as if they had. `migratePresetModels()` therefore CLEARS a stored
 * list that matches one of these (or the current catalog in
 * `SHIPPED_PRESET_MODELS`) byte for byte — see its comment for why the match
 * must be exact.
 *
 * Entries are removed once no shipped version can have written them (i.e. once
 * a build old enough to write this list is no longer in the wild). Do not add
 * a list here speculatively: a wrong entry would silently discard a user's own
 * edit.
 */
const LEGACY_PRESET_MODELS: Readonly<Record<string, readonly string[][]>> = {
  openai: [['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini', 'o1']],
  anthropic: [['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022']],
  gemini: [['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash']],
  deepseek: [['deepseek-chat', 'deepseek-reasoner']]
};

/**
 * Clear a preset's model list when it is still exactly a catalog this app
 * shipped — the list a fresh install was seeded with, not one the user built.
 *
 * The safety property is the exact match: same length AND same order. A stored
 * list that differs by even one id — added, removed, or reordered — is a user
 * edit, and any looser test (substring, subset, set equality) would silently
 * discard it. When the list matches nothing shipped the provider is left
 * completely untouched, including every field other than `models`.
 *
 * `cleared` reports that this provider's list was app-written, which is what
 * tells the caller the two named models may be app-written too (see
 * `loadSettings`). The returned value is in memory only; the caller's next
 * `persistSettings()` writes it. Clearing here must never write to disk on its
 * own, or merely reading settings would mutate the user's file.
 */
function migratePresetModels(provider: ProviderConfig): { provider: ProviderConfig; cleared: boolean } {
  // Every catalog this app shipped for this id: the current catalog plus each
  // legacy list. Empty for an id with no catalog — a hand-rolled relay's list is
  // the user's by construction, so nothing there may be cleared.
  const shipped: Array<readonly string[]> = [];
  const current = SHIPPED_PRESET_MODELS[provider.id];
  if (current) shipped.push(current);
  for (const legacy of LEGACY_PRESET_MODELS[provider.id] ?? []) shipped.push(legacy);

  const isShippedList = shipped.some(
    (list) => list.length === provider.models.length && list.every((id, i) => id === provider.models[i])
  );
  if (!isShippedList) return { provider, cleared: false };

  return { provider: { ...provider, models: [] }, cleared: true };
}

/** Default label of a template, or '' when the id has no template (e.g. `custom`). */
function presetNameFor(id: string): string {
  return PROVIDER_TEMPLATES.find((candidate) => candidate.id === id)?.name ?? '';
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
  /** Tiny model — default base for auxiliary background tasks (title, memory, etc.). */
  tinyModelName?: string;
  /** Title model — for summarizing session titles. */
  titleModelName?: string;
  /** Memory model — for extracting long-term memories. */
  memoryModelName?: string;
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
  modelConfigs?: Record<string, ModelOptionConfig>;
  /** Public origin to advertise in connect links (Web / iOS Safari PWA). */
  advertiseUrl?: string;
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

/**
 * Read `ui-settings.json`, merged over the environment.
 *
 * "Configured" means present in the user's own file or environment — never a
 * catalog this app ships. A fresh install therefore serves an empty model name
 * and empty provider lists: the presets are slots to fill, not models the user
 * chose. `DEFAULT_MAIN_MODEL`/`DEFAULT_REVIEW_MODEL` remain the core runner's
 * fallback (`packages/core/src/runner.ts`), so the app still runs with nothing
 * configured — it merely stops claiming a choice nobody made.
 */
function loadSettings(): UiSettings {
  const defaults: UiSettings = {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    baseURL: process.env.OPENAI_BASE_URL ?? '',
    modelName: process.env.OPENAI_MODEL_NAME ?? '',
    reviewModelName: process.env.OPENAI_REVIEW_MODEL_NAME ?? '',
    tinyModelName: process.env.OPENAI_TINY_MODEL_NAME ?? '',
    titleModelName: process.env.OPENAI_TITLE_MODEL_NAME ?? '',
    memoryModelName: process.env.OPENAI_MEMORY_MODEL_NAME ?? '',
    autoReview: (process.env.SUPERIU_AUTO_REVIEW ?? '1') !== '0',
    reasoningEffort: parseReasoningEffort(process.env.OPENAI_REASONING_EFFORT) ?? '',
    language: parseLanguage(process.env.SUPERIU_LANGUAGE) ?? DEFAULT_LANGUAGE,
    theme: DEFAULT_THEME,
    activeProviderId: '',
    advertiseUrl: process.env.SUPERIU_ADVERTISE_URL ?? ''
  };

  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) as Partial<UiSettings>;
    const effectiveKey = typeof raw.apiKey === 'string' ? raw.apiKey : defaults.apiKey;
    const effectiveBaseURL = typeof raw.baseURL === 'string' ? raw.baseURL : defaults.baseURL;

    let providers: ProviderConfig[] = Array.isArray(raw.providers) && raw.providers.length > 0
      ? raw.providers.map((p) => ({
          id: String(p.id || '').trim(),
          name: String(p.name || '').trim(),
          enabled: Boolean(p.enabled),
          apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
          baseURL: typeof p.baseURL === 'string' ? p.baseURL : '',
          models: Array.isArray(p.models) ? p.models.map(String) : [],
          description: typeof p.description === 'string' ? p.description : '',
          helpUrl: typeof p.helpUrl === 'string' ? p.helpUrl : '',
          custom: Boolean(p.custom),
          apiType: typeof p.apiType === 'string' && p.apiType.trim()
            ? p.apiType.trim()
            : defaultApiTypeFor(String(p.id || '').trim(), typeof p.baseURL === 'string' ? p.baseURL : '')
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

    // Clear a preset still carrying a catalog this app shipped: that list is the
    // app's default, not a model the user chose. Exact-match only, so a user's
    // own edit survives; see `migratePresetModels`. In memory only — the next
    // persist writes it.
    //
    // A cleared catalog is also proof that this file was written by the app,
    // which is what licenses clearing its default model names below: nobody
    // types a whole vendor catalog by hand, so nobody typed the name that
    // shipped beside it either.
    let appWrittenFile = false;
    providers = providers.map((provider) => {
      const migrated = migratePresetModels(provider);
      if (migrated.cleared) appWrittenFile = true;
      return migrated.provider;
    });

    let prunedPhantomSlots = false;
    const templateIds = new Set(PROVIDER_TEMPLATES.map((template) => template.id));
    providers = providers.filter((provider) => {
      const unconfigured = !provider.apiKey && provider.models.length === 0;
      if (!unconfigured) return true;
      const isTemplateSlot = templateIds.has(provider.id);
      const isEmptyCustom = provider.id === CUSTOM_PROVIDER_ID && !provider.baseURL && !provider.name;
      if (isTemplateSlot || isEmptyCustom) {
        prunedPhantomSlots = true;
        return false;
      }
      return true;
    });

    // A file with no providers at all, or one whose phantom slots were pruned,
    // was written by an app default rather than user configuration: mark it so
    // any shipped default model names beside it are cleared rather than kept.
    if (providers.length === 0 || prunedPhantomSlots) {
      appWrittenFile = true;
    }

    const activeProviderId = typeof raw.activeProviderId === 'string' && raw.activeProviderId
      ? (providers.some((p) => p.id === raw.activeProviderId)
          ? raw.activeProviderId
          : (providers.find((p) => p.enabled)?.id || providers[0]?.id || ''))
      : (providers.find((p) => p.enabled)?.id || providers[0]?.id || '');

    // The `enabled` flag is a projection of the active id, not independent
    // state: exactly the active provider is enabled, and none is when nothing is
    // active.
    for (const provider of providers) {
      provider.enabled = Boolean(activeProviderId) && provider.id === activeProviderId;
    }

    // Per-model answers to "does this model take `reasoning_effort`?" and "is it
    // offered at all". Bad entries are dropped rather than fatal: this file may
    // be hand-edited, and a typo in one model's list must not stop the server
    // from starting.
    const { configs: modelConfigs } = scanModelConfigs(raw.modelConfigs);

    // The two named models, resolved the way tiny/title/memory are: an ABSENT
    // key falls back to the environment, which configures models in its own
    // right, while an explicit empty value means "none" and is never re-filled —
    // resurrecting a shipped default there is what made a cleared field show a
    // model again on the next load.
    //
    // An app-written default in an app-written file is not a choice either, so it
    // goes with the catalog: only the exact shipped default is cleared, and only
    // while no surviving provider still lists it, so a name the user typed — or a
    // default they added to a provider — survives.
    const survivingModels = new Set(providers.flatMap((provider) => provider.models));
    const namedModel = (stored: unknown, shippedDefault: string, fromEnv: string | undefined): string => {
      if (typeof stored !== 'string') return fromEnv ?? '';
      if (!stored) return '';
      return appWrittenFile && stored === shippedDefault && !survivingModels.has(stored) ? '' : stored;
    };

    return {
      apiKey: effectiveKey,
      baseURL: effectiveBaseURL,
      modelName: namedModel(raw.modelName, DEFAULT_MAIN_MODEL, process.env.OPENAI_MODEL_NAME),
      reviewModelName: namedModel(raw.reviewModelName, DEFAULT_REVIEW_MODEL, process.env.OPENAI_REVIEW_MODEL_NAME),
      tinyModelName: typeof raw.tinyModelName === 'string' ? raw.tinyModelName.trim() : defaults.tinyModelName,
      titleModelName: typeof raw.titleModelName === 'string' ? raw.titleModelName.trim() : defaults.titleModelName,
      memoryModelName: typeof raw.memoryModelName === 'string' ? raw.memoryModelName.trim() : defaults.memoryModelName,
      autoReview: typeof raw.autoReview === 'boolean' ? raw.autoReview : defaults.autoReview,
      reasoningEffort: parseReasoningEffort(raw.reasoningEffort) ?? defaults.reasoningEffort,
      language: parseLanguage(raw.language) ?? defaults.language,
      theme: parseTheme(raw.theme) ?? defaults.theme,
      activeProviderId,
      providers,
      advertiseUrl: typeof raw.advertiseUrl === 'string' ? raw.advertiseUrl.trim() : defaults.advertiseUrl,
      ...(Object.keys(modelConfigs).length > 0 ? { modelConfigs } : {})
    };
  } catch {
    return {
      ...defaults,
      providers: [],
      activeProviderId: ''
    };
  }
}

/**
 * The keys this server owns in `ui-settings.json`.
 *
 * Every other key in the file belongs to a different shell — the desktop
 * wrapper stores `connectionMode`, `gateway`, `remote`, `workspaceRoot` and
 * `onboardingCompleted` there — and must survive a SPA settings save. The
 * `satisfies` clause is load-bearing: it turns "added a field to `UiSettings`
 * but forgot to own it" into a compile error instead of a silently dropped key.
 */
const SERVER_OWNED_KEY_FLAGS = {
  apiKey: true,
  baseURL: true,
  modelName: true,
  reviewModelName: true,
  tinyModelName: true,
  titleModelName: true,
  memoryModelName: true,
  autoReview: true,
  reasoningEffort: true,
  language: true,
  theme: true,
  activeProviderId: true,
  providers: true,
  modelConfigs: true,
  advertiseUrl: true
} satisfies Record<keyof UiSettings, true>;

/**
 * Merge `next` over the keys this server does not own, preserving foreign keys.
 *
 * `raw` is whatever the file held: a missing file or corrupt JSON is passed in
 * as `{}` by the caller, and anything that is not a plain object contributes
 * nothing. A foreign key present in `raw` is carried forward verbatim; one
 * absent from `raw` is never resurrected. `next` always wins for a key this
 * server owns, even when `raw` happens to carry a same-named foreign key.
 */
export function mergePersistedSettings(raw: unknown, next: Record<string, unknown>): Record<string, unknown> {
  const foreign: Record<string, unknown> = {};
  if (isPlainObject(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (!(key in SERVER_OWNED_KEY_FLAGS)) foreign[key] = value;
    }
  }
  return { ...foreign, ...next };
}

/**
 * Write the settings file, reporting failure as a stable sentence.
 *
 * The write is a read-modify-write: keys the server does not own (the desktop
 * wrapper's connection/onboarding state) are preserved verbatim, so a Settings
 * save can never strip them.
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
    // Read-modify-write: a missing/corrupt/non-object file has nothing foreign
    // to preserve, so it reads as `{}` and the merge yields `next`.
    let raw: unknown = {};
    try {
      raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    } catch {
      raw = {};
    }
    const merged = mergePersistedSettings(raw, next as unknown as Record<string, unknown>);
    fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
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

/** Placeholder credential for keyless provider endpoints, matching AgentRunner defaults. */
const PLACEHOLDER_KEY = 'placeholder-key';

/**
 * Resolve the provider configuration for a given model id.
 *
 * Priority order:
 * 1. An enabled provider matching `activeProviderId` that carries the model
 * 2. Any other enabled provider that carries the model (in configured order)
 * 3. Fallback to an enabled provider matching `activeProviderId`
 * 4. Fallback to the first enabled provider
 *
 * If no enabled providers exist, returns undefined so caller falls back to settings/env.
 */
function providerForModel(modelName?: string): ProviderConfig | undefined {
  if (!modelName) return undefined;
  const trimmed = modelName.trim();
  const enabledProviders = (settings.providers ?? []).filter((p) => p.enabled);
  if (enabledProviders.length === 0) return undefined;
  const active = enabledProviders.find((p) => p.id === settings.activeProviderId && p.models?.includes(trimmed));
  if (active) return active;
  const matching = enabledProviders.find((p) => p.models?.includes(trimmed));
  if (matching) return matching;
  const activeFallback = enabledProviders.find((p) => p.id === settings.activeProviderId);
  if (activeFallback) return activeFallback;
  return enabledProviders[0];
}

function runnerOptions(sessionReference?: string, historyDbPath?: string, newSession = false) {
  // A model the user has declared a level set for gets an EXPLICIT route, so the
  // level is a decision the router cannot second-guess: the capability gate only
  // decides the effort of a route that names none, and an explicit effort is
  // taken as an instruction (the same escape hatch `setModel` uses).
  //
  // EVERY role running on a constrained model needs its own route — not just
  // `main`. A role that names none inherits the router-wide
  // `defaultReasoningEffort` below, which is the user's GLOBAL preference: the
  // level they chose for a DIFFERENT model. A role on an unconstrained model
  // must keep inheriting that global value, so it deliberately gets no route
  // here, and `defaultReasoningEffort` stays the honest global preference rather
  // than the main model's clamped level.
  //
  // The `model` on each route is NOT redundant. `AgentRunner` spreads
  // `options.modelRoutes` LAST over its own env-derived routes
  // (`packages/core/src/runner.ts` :223-234, which is also where
  // `OPENAI_MEMORY_MODEL_NAME` / `OPENAI_TITLE_MODEL_NAME` are read), so a route
  // naming only an effort would silently clobber the model the env var selected.
  // Resolving the effective model here keeps both halves in agreement.
  const auxBase = settings.tinyModelName || settings.modelName;
  const effectiveModel: Record<ModelRole, string> = {
    main: settings.modelName,
    review: settings.reviewModelName,
    memory: settings.memoryModelName || process.env.OPENAI_MEMORY_MODEL_NAME || auxBase,
    title: settings.titleModelName || process.env.OPENAI_TITLE_MODEL_NAME || auxBase
  };
  const modelRoutes: Partial<Record<ModelRole, ModelRoute>> = {};
  for (const role of MODEL_ROLES) {
    const model = effectiveModel[role];
    const level = levelFor(model);
    const hasExplicitModel =
      (role === 'title' && Boolean(settings.titleModelName)) ||
      (role === 'memory' && Boolean(settings.memoryModelName));
    const provider = providerForModel(model);
    if (level !== undefined || hasExplicitModel || provider) {
      modelRoutes[role] = {
        model,
        provider: provider?.id,
        apiKey: provider ? (provider.apiKey || PLACEHOLDER_KEY) : undefined,
        baseURL: provider?.baseURL || undefined,
        ...(level ? { reasoningEffort: level } : {})
      };
    }
  }
  const mainProvider = providerForModel(settings.modelName);
  const effectiveApiKey = mainProvider?.apiKey || settings.apiKey || undefined;
  const effectiveBaseURL = mainProvider?.baseURL || settings.baseURL || undefined;
  const effectiveProvider = mainProvider?.apiType || defaultApiTypeFor(mainProvider?.id ?? '', mainProvider?.baseURL) || mainProvider?.id || settings.activeProviderId;

  return {
    workspaceDir: activeWorkspaceDir,
    apiKey: effectiveApiKey,
    baseURL: effectiveBaseURL,
    provider: effectiveProvider || undefined,
    modelName: settings.modelName || undefined,
    reviewModelName: settings.reviewModelName || undefined,
    autoReview: settings.autoReview,
    // `''` means derive (env, else core's `medium`). An explicit option wins
    // over `OPENAI_REASONING_EFFORT`, matching how the other settings resolve.
    // This is the user's GLOBAL preference and must stay exactly that: it is the
    // fallback for every role whose model declares no level set, so deriving it
    // from the main model's clamped level would leak that clamp onto roles
    // running a different model (a constrained `main` would drag an
    // unconstrained `review` down to the main model's level). A constrained role
    // carries its own effort on its route above instead.
    defaultReasoningEffort: settings.reasoningEffort || undefined,
    // Per-model capability answer, so a user-declared level set reaches models
    // the built-in allowlist does not know and an explicit `[]` suppresses the
    // parameter on a model the allowlist would have allowed.
    modelReasoningCapable,
    contextLimitFor: (model: string) => settings.modelConfigs?.[(model || '').trim()]?.contextLimit,
    ...(Object.keys(modelRoutes).length > 0 ? { modelRoutes } : {}),
    sessionId: sessionReference,
    // A draft has no file to reopen, so a rebuild must skip the resume path
    // rather than be handed a path that does not exist yet.
    newSession,
    historyDbPath,
    // The MCP config path follows the runner across settings rebuilds, so a
    // test-pinned (or disabled) path survives `applySettings`.
    mcpConfigPath: activeMcpConfigPath,
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

/**
 * Set while the daemon is draining for a self-update: new turns are refused so
 * an in-flight one can finish. Owned by {@link ServerHandle.setDraining}.
 */
let draining = false;

/** The live gateway, when one was booted, so the handle can reach its drain state. */
let gatewayRef: GatewayServer | undefined;

// Created by startServer: importing this module must have no side effects.
let settings: UiSettings = loadSettings();
let runner: AgentRunner = null as unknown as AgentRunner;
let activeAuth: AuthLayer | null = null;
let activeWorkspaceDir = process.cwd();
/** MCP config path pinned by `startServer`; `undefined` = the manager default. */
let activeMcpConfigPath: string | null | undefined;
let memoryDir = '';
/** Build version reported by `buildStatus`; set by startServer from `options.version`. */
let serverVersion = '0.0.0';
/** Update hooks backing `/api/update`. */
let updateHooks: UpdateHooks = {};
let pendingDrainUpdate: (() => Promise<void>) | null = null;

export interface PendingResumeMarker {
  sessionId: string;
  leafId?: string;
  timestamp: number;
  reason: 'server_update';
}

export function pendingResumeFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, '.superiu', 'pending_resume.json');
}

export function writePendingResumeMarker(workspaceDir: string, marker: PendingResumeMarker): void {
  const file = pendingResumeFilePath(workspaceDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(marker, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    process.stderr.write(`superiu-server: could not write pending resume marker: ${errorMessage(err)}\n`);
  }
}

export function checkAndConsumePendingResume(workspaceDir: string): PendingResumeMarker | null {
  const file = pendingResumeFilePath(workspaceDir);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    fs.unlinkSync(file);
    return JSON.parse(raw) as PendingResumeMarker;
  } catch (err) {
    process.stderr.write(`superiu-server: could not read pending resume marker: ${errorMessage(err)}\n`);
    return null;
  }
}

/**
 * Whether the user has told us this model takes `reasoning_effort`.
 *
 * `undefined` means "no opinion" and defers to the core allowlist, which is what
 * keeps a model the user never touched behaving exactly as before. An EMPTY
 * `efforts` list is an explicit `false`: the model refuses the parameter, so a
 * level must not be attached even though the allowlist would allow one.
 */
function modelReasoningCapable(model: string): boolean | undefined {
  const cfg = settings.modelConfigs?.[model.trim()];
  if (cfg && Array.isArray(cfg.efforts)) return cfg.efforts.length > 0;
  return undefined;
}

/** The levels the user has declared for `model`, or `undefined` when unconstrained. */
function configuredEfforts(model: string): ReasoningEffort[] | undefined {
  const cfg = settings.modelConfigs?.[(model || '').trim()];
  return cfg && Array.isArray(cfg.efforts) ? cfg.efforts : undefined;
}

/**
 * The level to send for `model`, preferring the stored preference.
 *
 * The stored `reasoningEffort` is a global preference, not a per-model fact, so
 * it may name a level this model does not accept (`high` for a model narrowed to
 * `low`). Rather than send a level the model rejects, fall back to the strongest
 * one it does accept — the last element, since the list is written in canonical
 * ascending order.
 */
function levelFor(model: string): ReasoningEffort | undefined {
  const allowed = configuredEfforts(model);
  if (!allowed || allowed.length === 0) return undefined;
  // An empty stored value means "derive", whose documented meaning is the core
  // default (`medium`) — declaring the full list ['low','medium','high'] must
  // therefore behave exactly like declaring nothing, rather than silently
  // promoting the route to the strongest level on the ladder.
  const chosen = settings.reasoningEffort || DEFAULT_REASONING_EFFORT;
  return allowed.includes(chosen) ? chosen : allowed[allowed.length - 1];
}

/**
 * The model ids the user has actually configured, de-duplicated: every id in a
 * provider's own `models[]` (in provider order), then the two named models.
 *
 * This is what the API serves as `modelChoices`, and it is deliberately NOT
 * `MODEL_CHOICES`: the shipped catalog is a suggestion list, and offering it as
 * a selection is what made an install with nothing configured display a model.
 * Empty strings are dropped, so an unconfigured install yields `[]`.
 */
function configuredModelIds(): string[] {
  const ids: string[] = [];
  for (const provider of settings.providers ?? []) {
    for (const model of provider.models ?? []) ids.push(model);
  }
  ids.push(settings.modelName, settings.reviewModelName);
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

/**
 * Every model id the console can describe, de-duplicated: the shipped catalog
 * plus everything configured.
 *
 * The union covers the shipped suggestions, every provider's own model list and
 * the two named models — a provider's `models[]` is where a hand-typed id lands,
 * so covering only `MODEL_CHOICES` would leave the user's own model without a
 * context window and the usage meter dividing by the default. It backs the
 * capability and reasoning maps, which must be able to label a suggestion before
 * it is ever chosen; it must never be served as a selection, which is
 * `configuredModelIds()`'s job.
 */
function advertisedModelIds(): string[] {
  return [...new Set([...MODEL_CHOICES, ...configuredModelIds()])];
}

interface PublicModelRoute {
  model: string;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
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
 * Capability metadata for every model the console can describe, keyed by id.
 *
 * Keyed by `advertisedModelIds()` rather than the configured set, because the
 * renderer must be able to label a shipped suggestion the moment the user types
 * it into the grid — before any provider lists it.
 */
function modelMetadataView(): Record<string, ModelMetadata> {
  return Object.fromEntries(
    advertisedModelIds().map((id) => {
      const base = modelMetadataFor(id);
      const customLimit = settings.modelConfigs?.[id]?.contextLimit;
      if (customLimit) {
        return [id, { ...base, contextLimit: customLimit, formattedContext: formatContextLimit(customLimit) }];
      }
      return [id, base];
    })
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
    // Only what the user configured: the shipped catalog is a suggestion list,
    // and serving it here is what put 12 models in the ⌘J selector of an
    // install with none configured.
    modelChoices: configuredModelIds(),
    modelRoutes: publicRoutes(),
    contextTokens: contextUsage.tokens,
    contextLimit: contextUsage.limit,
    contextPercent: contextUsage.percent,
    reasoningEffort: runner.getModelRoutes().main.reasoningEffort ?? '',
    memoryDir,
    version: serverVersion,
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
  const providersList = (settings.providers ?? []).map((p) => ({
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
    custom: Boolean(p.custom),
    apiType: p.apiType || defaultApiTypeFor(p.id, p.baseURL)
  }));

  return {
    apiKeyMasked: maskApiKey(settings.apiKey),
    apiKeySet: settings.apiKey.length > 0,
    baseURL: settings.baseURL,
    modelName: settings.modelName,
    reviewModelName: settings.reviewModelName,
    tinyModelName: settings.tinyModelName || '',
    titleModelName: settings.titleModelName || '',
    memoryModelName: settings.memoryModelName || '',
    autoReview: settings.autoReview,
    advertiseUrl: settings.advertiseUrl || '',
    language: settings.language,
    theme: settings.theme,
    reasoningEffort: settings.reasoningEffort,
    reasoningEffortEffective: runner.getModelRoutes().main.reasoningEffort ?? '',
    reasoningSupported:
      modelReasoningCapable(settings.modelName) ?? supportsReasoningEffort(settings.modelName),
    /**
     * Per-model answers, as stored: only entries the user actually configured.
     * The renderer distinguishes "no entry" (nothing to say) from an entry with
     * an empty `efforts` (this model refuses the parameter), so an empty map must
     * not be padded with defaults here.
     */
    modelConfigs: settings.modelConfigs ?? {},
    /**
     * Whether the built-in detector considers each offered model
     * reasoning-capable. The renderer cannot know the core allowlist, so without
     * this a model with no stored entry would have to be shown as "unknown"
     * rather than in its own automatic state.
     */
    modelReasoning: Object.fromEntries(advertisedModelIds().map((id) => [id, supportsReasoningEffort(id)])),
    /**
     * The user's own models — see `configuredModelIds`. NOT the shipped
     * catalog: a select or a pill rendering this list must show nothing at all
     * until the user has configured a model.
     */
    modelChoices: configuredModelIds(),
    /**
     * The shipped id catalog, for the model grid's `#model-choices` datalist
     * autocomplete only. It is deliberately separate from `modelChoices`: these
     * are suggestions the user may pick, not models they have chosen, and no
     * select may render them.
     */
    knownModels: MODEL_CHOICES,
    /**
     * Capability metadata (vision / tools / context window) per model id. The
     * renderer needs the window to label a model picker and the usage meter to
     * divide by the right number, and neither can compute it: the numbers are
     * per-provider facts, not derivable from the id.
     */
    modelMetadata: modelMetadataView(),
    activeProviderId: (settings.activeProviderId && providersList.some((p) => p.id === settings.activeProviderId))
      ? settings.activeProviderId
      : (providersList.find((p) => p.enabled)?.id || ''),
    providerTemplates: PROVIDER_TEMPLATES,
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
  if (typeof patch.tinyModelName === 'string') {
    next.tinyModelName = patch.tinyModelName.trim();
  }
  if (typeof patch.titleModelName === 'string') {
    next.titleModelName = patch.titleModelName.trim();
  }
  if (typeof patch.memoryModelName === 'string') {
    next.memoryModelName = patch.memoryModelName.trim();
  }
  if (typeof patch.autoReview === 'boolean') next.autoReview = patch.autoReview;
  if (typeof patch.advertiseUrl === 'string') {
    next.advertiseUrl = patch.advertiseUrl.trim();
    if (activeAuth) activeAuth.setAdvertiseUrl(next.advertiseUrl || undefined);
  }
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
  if (patch.modelConfigs !== undefined) {
    // A full replacement, not a merge: the map is what the model grid shows, and
    // a merge would make "uncheck this model" impossible to express — an omitted
    // entry has to mean "no opinion", which is indistinguishable from "deleted".
    const { configs, errors } = scanModelConfigs(patch.modelConfigs);
    if (errors.length > 0) {
      // Path-free and specific: this copy is rendered verbatim in the Settings
      // dialog, so it names the offending entry rather than the settings file.
      throw new Error(`Invalid modelConfigs: ${errors[0]}.`);
    }
    next.modelConfigs = configs;
  }

  if (Array.isArray(patch.providers)) {
    const existing = next.providers ?? [];
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
        custom: typeof item.custom === 'boolean' ? item.custom : (prev?.custom ?? false),
        apiType: typeof item.apiType === 'string' && item.apiType.trim()
          ? item.apiType.trim()
          : (prev?.apiType || defaultApiTypeFor(id, typeof item.baseURL === 'string' ? item.baseURL : (prev?.baseURL ?? '')))
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
    const providers = next.providers ?? [];
    next.providers = providers;
    if (typeof patch.activeProviderId === 'string') {
      next.activeProviderId = patch.activeProviderId;
    }
    if (patch.providers === undefined && patch.activeProviderId !== undefined) {
      for (const provider of providers) {
        provider.enabled = provider.id === next.activeProviderId;
      }
    }
    // A patch may name an id no entry carries — the user deleted the active
    // provider, or the renderer sent a stale one. Re-point at the first enabled
    // survivor (or first provider) so the id never dangles or pins a disabled provider.
    const activeEntry = providers.find((p) => p.id === next.activeProviderId);
    const enabledSurvivor = providers.find((p) => p.enabled);
    if (!activeEntry || (!activeEntry.enabled && enabledSurvivor)) {
      next.activeProviderId = enabledSurvivor?.id ?? providers[0]?.id ?? '';
    }
    // Promote the active provider's credential to the top-level pair. When
    // nothing is active the projection is empty, so the app is explicitly
    // unconfigured rather than silently sending a previous provider's key.
    const activeProvider = providers.find((provider) => provider.id === next.activeProviderId);
    next.apiKey = activeProvider?.apiKey ?? '';
    next.baseURL = activeProvider?.baseURL ?? '';
  }

  const prevActive = (settings.providers ?? []).find((p) => p.id === settings.activeProviderId);
  const nextActive = (next.providers ?? []).find((p) => p.id === next.activeProviderId);
  const prevApiType = prevActive?.apiType || defaultApiTypeFor(prevActive?.id ?? '', prevActive?.baseURL);
  const nextApiType = nextActive?.apiType || defaultApiTypeFor(nextActive?.id ?? '', nextActive?.baseURL);
  const apiTypeChanged = prevApiType !== nextApiType;

  const providerFingerprint = (list?: ProviderConfig[]) =>
    JSON.stringify(
      (list ?? []).map((p) => ({
        id: p.id,
        enabled: p.enabled,
        apiKey: p.apiKey,
        baseURL: p.baseURL,
        apiType: p.apiType,
        models: p.models
      }))
    );

  const runnerChanged =
    next.apiKey !== settings.apiKey ||
    next.baseURL !== settings.baseURL ||
    next.activeProviderId !== settings.activeProviderId ||
    apiTypeChanged ||
    next.modelName !== settings.modelName ||
    next.reviewModelName !== settings.reviewModelName ||
    next.tinyModelName !== settings.tinyModelName ||
    next.titleModelName !== settings.titleModelName ||
    next.memoryModelName !== settings.memoryModelName ||
    next.autoReview !== settings.autoReview ||
    providerFingerprint(next.providers) !== providerFingerprint(settings.providers) ||
    // scan canonicalizes `efforts`, so an entry written as ['high','low'] is not
    // a change against one stored as ['low','high'].
    JSON.stringify(next.modelConfigs ?? {}) !== JSON.stringify(settings.modelConfigs ?? {});

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
  const previousRunner = runner;
  previousRunner.close();
  // MCP connections live on the old runner's manager, which close() does not
  // touch: disconnect explicitly so a settings rebuild cannot leak the stdio
  // child processes a live server is backed by.
  void previousRunner.getMcpManager().closeAll().catch(() => undefined);
  runner = new AgentRunner(
    runnerOptions(draft ? undefined : activeSession ?? undefined, undefined, draft)
  );
  runner.emotion = carriedEmotion;
  // Reconnect the configured MCP servers on the rebuilt runner. `applySettings`
  // is synchronous, so this is fire-and-forget: failures are contained per
  // server by the manager and surface via `/api/mcp`, not in the save response.
  void runner.initMcp().catch((err) => console.warn('[server] initMcp warning:', err));

  return { restarted: true, sessionId: runner.getSessionId() };
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

/** Coerce a JSON object into a string map, dropping non-object inputs. */
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, String(val)]));
}

/**
 * The `/api/mcp` payload: the raw on-disk server map plus a live status row per
 * configured server.
 *
 * `servers` mirrors the config file exactly (the internal `name` key is the map
 * key on disk, not a property of the value), while `statuses` joins each config
 * with its connection state, its advertised tools and the manager's last
 * recorded error — the union a settings surface needs to render both "what is
 * configured" and "what is actually running".
 */
async function buildMcpPayload(target: AgentRunner) {
  const manager = target.getMcpManager();
  const configPath = manager.getConfigPath() ?? path.join(os.homedir(), '.superiu', 'mcp.json');
  const configs = manager.listServerConfigs();
  // A server that cannot answer listTools degrades to an empty tool list rather
  // than failing the whole payload.
  const tools = await manager.listTools().catch(() => []);
  const lastErrors = manager.getLastErrors();

  const servers: Record<string, unknown> = {};
  for (const cfg of configs) {
    const { name, ...rest } = cfg;
    servers[name] = rest;
  }

  const statuses = configs.map((cfg) => {
    const isLive = manager.isConnected(cfg.name);
    const serverTools = tools
      .filter((t) => t.serverName === cfg.name)
      .map((t) => ({ name: t.name, description: t.description ?? '' }));
    const stdio = cfg as { command?: string; args?: string[]; cwd?: string };
    const sse = cfg as { url?: string };
    return {
      name: cfg.name,
      enabled: cfg.enabled !== false,
      connected: isLive,
      transport: typeof sse.url === 'string' ? 'sse' : 'stdio',
      command: stdio.command,
      args: stdio.args,
      cwd: stdio.cwd,
      url: sse.url,
      error: lastErrors[cfg.name] ?? null,
      tools: serverTools
    };
  });

  return { configPath, servers, statuses };
}

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
  '/api/update': ['GET', 'POST'],
  '/api/mcp': ['GET'],
  '/api/mcp/server': ['POST', 'DELETE'],
  '/api/mcp/toggle': ['POST'],
  '/api/mcp/reload': ['POST'],
  '/api/mcp/raw': ['POST'],
  '/api/mcp/delete': ['POST'],
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

  if (pathname === '/readyz' && method === 'GET') {
    sendJson(res, 200, { status: 'ready', version: serverVersion, pid: process.pid });
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

    const apiType = typeof body.apiType === 'string' && body.apiType.trim()
      ? body.apiType.trim()
      : '';

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
        if (endpoint.includes('anthropic.com')) {
          headers['x-api-key'] = targetKey;
          headers['anthropic-version'] = '2023-06-01';
        }
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
    //
    // The level is recomputed for the NEW model. `setModel` merges onto the role's
    // existing route, so a role left over from a model the user configured a level
    // list for would otherwise keep sending that level — an explicit effort the
    // router cannot second-guess — to a model that may reject the parameter
    // outright. `undefined` clears it back to the inherited default, which is what
    // an unconstrained model is supposed to get.
    const provider = providerForModel(model);
    runner.setModel(role, {
      model,
      provider: provider?.id,
      apiKey: provider ? (provider.apiKey || PLACEHOLDER_KEY) : undefined,
      baseURL: provider?.baseURL || undefined,
      reasoningEffort: levelFor(model)
    });

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
    const presentationOnly = Object.keys(body).every(
      (key) => key === 'language' || key === 'theme' || key === 'advertiseUrl'
    );

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
      model: session.model,
      reasoningEffort: session.reasoningEffort,
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
    const currentRoute = runner.getModelRoutes().main;
    settings.modelName = currentRoute.model;
    const headerEffort = parseReasoningEffort(runner.session.header.reasoningEffort);
    if (headerEffort !== undefined) {
      settings.reasoningEffort = headerEffort;
    }
    persistSettings(settings);
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
      const currentRoute = runner.getModelRoutes().main;
      const provider = providerForModel(currentRoute.model);
      runner.setModel('main', {
        model: currentRoute.model,
        provider: provider?.id,
        apiKey: provider ? (provider.apiKey || PLACEHOLDER_KEY) : undefined,
        baseURL: provider?.baseURL || undefined,
        reasoningEffort: currentRoute.reasoningEffort
      });
      settings.modelName = currentRoute.model;
      const headerEffort = parseReasoningEffort(runner.session.header.reasoningEffort);
      if (headerEffort !== undefined) {
        settings.reasoningEffort = headerEffort;
      }
      persistSettings(settings);
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

  if (pathname === '/api/update' && method === 'GET') {
    if (updateHooks.onCheckUpdate) {
      try {
        const result = await updateHooks.onCheckUpdate();
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 200, {
          current: serverVersion,
          hasUpdate: false,
          canUpdate: true,
          error: errorMessage(err)
        });
      }
    } else {
      sendJson(res, 200, {
        current: serverVersion,
        hasUpdate: false,
        canUpdate: false
      });
    }
    return true;
  }

  if (pathname === '/api/update' && method === 'POST') {
    if (!updateHooks.onApplyUpdate) {
      sendError(res, 400, 'Server self-update is not supported in this runtime mode.');
      return true;
    }
    const isIdle =
      runner?.status === 'idle' && pendingApprovals.size === 0 && (!gatewayRef || gatewayRef.isIdle());
    if (!isIdle) {
      draining = true;
      pendingDrainUpdate = async () => {
        try {
          if (runner?.getSessionId()) {
            writePendingResumeMarker(activeWorkspaceDir, {
              sessionId: runner.getSessionId(),
              leafId: runner.getLeafId() ?? undefined,
              timestamp: Date.now(),
              reason: 'server_update'
            });
          }
        } catch (err) {
          process.stderr.write(`superiu-server: failed to write resume marker: ${errorMessage(err)}\n`);
        }
        try {
          await updateHooks.onApplyUpdate!();
        } catch (err) {
          process.stderr.write(`superiu-server: update apply failed: ${errorMessage(err)}\n`);
        }
      };
      sendJson(res, 200, {
        ok: true,
        status: 'draining',
        message: 'Update scheduled: waiting for active turn completion.'
      });
      return true;
    }
    sendJson(res, 200, { ok: true, status: 'applying' });
    setTimeout(async () => {
      try {
        await updateHooks.onApplyUpdate!();
      } catch (err) {
        process.stderr.write(`superiu-server: update apply failed: ${errorMessage(err)}\n`);
      }
    }, 80).unref();
    return true;
  }

  if (pathname === '/api/chat' && method === 'POST') {
    await handleChat(req, res);
    return true;
  }

  // -------------------------------------------------------------------------
  // MCP management: the `/api/mcp*` family edits `mcp.json` through the
  // runner's manager and answers with the fresh payload, so the settings
  // surface never reads the file itself.
  // -------------------------------------------------------------------------

  if (pathname === '/api/mcp' && method === 'GET') {
    sendJson(res, 200, await buildMcpPayload(runner));
    return true;
  }

  if (pathname === '/api/mcp/server' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, errorMessage(err));
      return true;
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      sendError(res, 400, 'Missing required field: name');
      return true;
    }
    const transport = body.transport === 'stdio' || body.transport === 'sse' ? body.transport : null;
    if (!transport) {
      sendError(res, 400, `Field 'transport' must be 'stdio' or 'sse'`);
      return true;
    }
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

    let config: McpServerConfig;
    if (transport === 'stdio') {
      const command = typeof body.command === 'string' ? body.command.trim() : '';
      if (!command) {
        sendError(res, 400, `Field 'command' is required for stdio servers`);
        return true;
      }
      const env = stringRecord(body.env);
      config = {
        name,
        enabled,
        command,
        ...(Array.isArray(body.args) ? { args: body.args.map((arg) => String(arg)) } : {}),
        ...(env ? { env } : {}),
        ...(typeof body.cwd === 'string' && body.cwd.trim() ? { cwd: body.cwd } : {})
      };
    } else {
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      if (!url) {
        sendError(res, 400, `Field 'url' is required for sse servers`);
        return true;
      }
      const headers = stringRecord(body.headers);
      config = {
        name,
        enabled,
        url,
        ...(headers ? { headers } : {})
      };
    }

    const manager = runner.getMcpManager();
    manager.addServer(config);
    await manager.saveConfigFile();
    if (config.enabled !== false) {
      // A server that fails to start degrades itself through the manager's
      // error ledger; the add still succeeds so the config is not lost.
      await manager.connect(name);
    }
    await runner.refreshTools();
    sendJson(res, 200, await buildMcpPayload(runner));
    return true;
  }

  if (
    (pathname === '/api/mcp/server' && method === 'DELETE') ||
    (pathname === '/api/mcp/delete' && method === 'POST')
  ) {
    // The name arrives as `?name=…` (DELETE) or in the JSON body (POST); a
    // DELETE may carry a body too, so fall back to it either way.
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    let name = url.searchParams.get('name')?.trim() ?? '';
    if (!name) {
      try {
        const body = await readJsonBody(req);
        name = typeof body.name === 'string' ? body.name.trim() : '';
      } catch {
        name = '';
      }
    }
    if (!name) {
      sendError(res, 400, 'Missing required field: name');
      return true;
    }

    const manager = runner.getMcpManager();
    await manager.removeServer(name);
    await manager.saveConfigFile();
    await runner.refreshTools();
    sendJson(res, 200, await buildMcpPayload(runner));
    return true;
  }

  if (pathname === '/api/mcp/toggle' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, errorMessage(err));
      return true;
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      sendError(res, 400, 'Missing required field: name');
      return true;
    }
    if (typeof body.enabled !== 'boolean') {
      sendError(res, 400, `Field 'enabled' must be a boolean`);
      return true;
    }

    const manager = runner.getMcpManager();
    try {
      if (body.enabled) {
        await manager.enableServer(name);
      } else {
        await manager.disableServer(name);
      }
    } catch (err) {
      // `enableServer` throws for an unknown name; that is a client error, not
      // a server fault.
      sendError(res, 404, errorMessage(err));
      return true;
    }
    await manager.saveConfigFile();
    await runner.refreshTools();
    sendJson(res, 200, await buildMcpPayload(runner));
    return true;
  }

  if (pathname === '/api/mcp/reload' && method === 'POST') {
    const manager = runner.getMcpManager();
    await manager.reload();
    await runner.refreshTools();
    sendJson(res, 200, await buildMcpPayload(runner));
    return true;
  }

  if (pathname === '/api/mcp/raw' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, errorMessage(err));
      return true;
    }

    // `raw` is the config file as a JSON string (a paste from an editor);
    // otherwise the body itself carries `mcpServers`.
    let parsed: unknown;
    if (typeof body.raw === 'string') {
      try {
        parsed = JSON.parse(body.raw);
      } catch {
        sendError(res, 400, 'Invalid JSON');
        return true;
      }
    } else {
      parsed = body;
    }

    if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) {
      sendError(res, 400, 'Body must include an "mcpServers" object');
      return true;
    }

    const manager = runner.getMcpManager();
    const configPath = manager.getConfigPath() ?? path.join(os.homedir(), '.superiu', 'mcp.json');
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
    } catch (err) {
      sendError(res, 500, errorMessage(err));
      return true;
    }
    await manager.reload();
    await runner.refreshTools();
    sendJson(res, 200, await buildMcpPayload(runner));
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

  if (draining) {
    sendError(res, 503, 'Server is updating, please retry shortly.');
    return;
  }

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
    if (pendingDrainUpdate) {
      const drain = pendingDrainUpdate;
      pendingDrainUpdate = null;
      setTimeout(async () => {
        try {
          await drain();
        } catch (err) {
          process.stderr.write(`superiu-server: drain update failed: ${errorMessage(err)}\n`);
        }
      }, 80).unref();
    }
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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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

  const ext = path.extname(filePath).toLowerCase();
  const isHtml = ext === '.html';

  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': isHtml
      ? 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
      : 'no-cache, must-revalidate'
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
 * Prepare a Unix domain socket path for `listen()`: create the parent directory
 * and clear a stale socket file. A leftover file from a crashed process would
 * make `listen()` fail with EADDRINUSE; clearing it is safe because nothing is
 * bound there.
 */
function prepareSocketPath(socketPath: string): void {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  try {
    fs.rmSync(socketPath, { force: true });
  } catch {
    // Best effort: listen() will surface a real problem.
  }
}

/**
 * Best-effort `0600` on a freshly-bound socket. A filesystem that refuses chmod
 * still has a working socket, so this must never fail a boot.
 */
function secureSocketPath(socketPath: string): void {
  try {
    fs.chmodSync(socketPath, 0o600);
  } catch {
    // A filesystem that refuses chmod still has a working socket.
  }
}

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
  const socketPath = options.socketPath ? path.resolve(options.socketPath) : undefined;
  const workspaceDir = path.resolve(options.workspaceDir ?? process.cwd());

  // Dual-listen: a Unix domain socket AND a TCP port at once. This is only a
  // TCP boot when the caller explicitly named a positive port — an omitted port
  // still defaults to 3000 for pure-TCP mode, but must not silently add a TCP
  // listener when only a socket was requested. `port: 0` opts a socket-only boot
  // back in explicitly.
  const dualListen = socketPath !== undefined && options.port !== undefined && options.port > 0;

  PUBLIC_DIR = options.publicDir ? path.resolve(options.publicDir) : path.resolve(HERE, '..', 'public');
  SETTINGS_FILE = options.settingsFile
    ? path.resolve(options.settingsFile)
    : path.join(workspaceDir, '.superiu', 'ui-settings.json');
  activeWorkspaceDir = workspaceDir;

  settings = loadSettings();
  memoryDir = await resolveMemoryDir();
  serverVersion = options.version ?? '0.0.0';
  updateHooks = options.updateHooks ?? {};
  activeMcpConfigPath = options.mcpConfigPath;
  runner = new AgentRunner(runnerOptions());

  // Connect the MCP servers from the config file so their tools are available
  // from the first turn. Failures are contained per server by the manager — a
  // broken `mcp.json` entry must not stop the web shell from booting.
  await runner.initMcp().catch((err) => console.warn('[server] initMcp warning:', err));

  const resumeMarker = checkAndConsumePendingResume(activeWorkspaceDir);
  if (resumeMarker?.sessionId) {
    try {
      runner.loadSession(resumeMarker.sessionId);
      console.log(`[superiu] resumed session ${resumeMarker.sessionId} from pending update marker`);
    } catch (err) {
      process.stderr.write(
        `superiu-server: failed to restore resumed session ${resumeMarker.sessionId}: ${errorMessage(err)}\n`
      );
    }
  }

  // Pairing auth sits in front of the API. The mode is explicit when the
  // embedder pinned it, otherwise derived from `SUPERIU_WEB_AUTH` and the AUTO
  // rule (non-loopback bind, or a stored key/code).
  const authMode =
    options.webAuth === true
      ? 'on'
      : options.webAuth === false
        ? 'off'
        : authModeFromEnv(process.env.SUPERIU_WEB_AUTH);
  const auth = new AuthLayer({
    workspaceDir,
    host,
    mode: authMode,
    advertiseUrl: settings.advertiseUrl || process.env.SUPERIU_ADVERTISE_URL
  });
  activeAuth = auth;

  // The single request handler both listeners share, so the SPA and API answer
  // identically whether a client reaches the server over TCP or the socket.
  const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    void (async () => {
      try {
        if (await auth.handle(req, res, url)) return;
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
  };

  const server = http.createServer(requestHandler);

  const listening = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    if (socketPath && !dualListen) {
      prepareSocketPath(socketPath);
      server.listen(socketPath, () => resolve(0));
      return;
    }
    server.listen(port, host, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });

  // Second listener for dual mode. A failure here must not leave the TCP
  // listener holding the port, so tear it down before surfacing the error.
  let socketServer: http.Server | undefined;
  if (dualListen && socketPath) {
    const secondary = http.createServer(requestHandler);
    try {
      await new Promise<void>((resolve, reject) => {
        secondary.once('error', reject);
        prepareSocketPath(socketPath);
        secondary.listen(socketPath, () => resolve());
      });
    } catch (err) {
      await new Promise<void>((resolve) => secondary.close(() => resolve()));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      throw err;
    }
    socketServer = secondary;
  }

  if (socketPath) secureSocketPath(socketPath);

  // Boot the VPS Gateway on the SAME server so `@agent/ui` serves the SPA and
  // the WebSocket endpoint from one port. `gatewayPath: null` opts out.
  let gateway: GatewayServer | undefined;
  if (options.gatewayPath !== null) {
    gateway = new GatewayServer({
      server,
      path: options.gatewayPath ?? '/ws',
      token: options.gatewayToken,
      serverVersion: options.version,
      // The runner is reached through the narrow `GatewayRunner` surface: the
      // gateway only needs to run a turn, abort one, and report the current
      // session, never the whole core class.
      runner: runner as unknown as GatewayRunner
    });
    // Dual-listen: answer `/ws` upgrades on the socket listener too, so a
    // loopback/tunnel client and a browser client share one gateway.
    if (socketServer) gateway.attachSecondary(socketServer);
    gatewayRef = gateway;
  }

  if (!options.quiet) {
    const workstation = runner.getWorkstation();
    // Diagnostics for whoever started the server, so they report the model the
    // runner will actually call rather than the configured name: with nothing
    // configured that is the core fallback (`packages/core/src/runner.ts`), and
    // an empty field here would hide it. The `(default)` marker keeps a fallback
    // from reading as a choice the user made — the same distinction the web
    // shell draws by serving `model: ''` to the composer.
    const effective = runner.getModelRoutes();
    const describeModel = (configured: string, inForce: string): string =>
      configured ? configured : `${inForce} (default)`;
    console.log('=== SuperIU Web UI (@agent/ui) ===');
    const listeningLabel = dualListen
      ? `${socketPath} + http://${host}:${listening}`
      : socketPath
        ? socketPath
        : `http://${host}:${listening}`;
    console.log(`  Listening:   ${listeningLabel}`);
    console.log(`  Main model:  ${describeModel(settings.modelName, effective.main.model)}`);
    console.log(`  Language:    ${settings.language}`);
    console.log(`  Theme:       ${settings.theme}`);
    console.log(
      `  Tool model:  ${describeModel(settings.reviewModelName, effective.review.model)} (autoReview ${settings.autoReview ? 'on' : 'off'})`
    );
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
    console.log(`  Pairing:     ${auth.isEnabled() ? 'required' : 'off (loopback / no keys)'}`);
    if (gateway) console.log(`  Gateway:     ws://${host}:${listening}${gateway.path}`);
    console.log('');
  }

  let closing: Promise<void> | null = null;

  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      resolvePendingApprovals(false);
      // Close the gateway first so its upgrade listeners stop and every client
      // receives a clean close before the HTTP servers go down.
      const gatewayClose = gateway ? gateway.close() : Promise.resolve();
      void gatewayClose.then(() => {
        // Both listeners must be down before the runner is released; the socket
        // file is removed once they are.
        let remaining = socketServer ? 2 : 1;
        const onClosed = (): void => {
          remaining -= 1;
          if (remaining > 0) return;
          if (socketPath) {
            try {
              fs.rmSync(socketPath, { force: true });
            } catch {
              // Best effort: the socket file is cleaned up on next boot anyway.
            }
          }
          runner.close();
          // MCP stdio servers are child processes owned by the runner's
          // manager, which runner.close() does not reach: disconnect them
          // before resolving so close() leaves no spawned server behind.
          void runner.getMcpManager().closeAll().catch(() => undefined).then(() => resolve());
        };
        server.close(onClosed);
        // Idle keep-alive sockets would otherwise hold the close callback open.
        server.closeAllConnections?.();
        if (socketServer) {
          socketServer.close(onClosed);
          socketServer.closeAllConnections?.();
        }
      });
    });
    return closing;
  };

  shutdownHook = () => void close();
  return {
    port: listening,
    host,
    url: dualListen || !socketPath ? `http://${host}:${listening}` : `http://unix:${socketPath}`,
    socketPath,
    language: settings.language,
    theme: settings.theme,
    gateway,
    gatewayUrl: gateway
      ? dualListen || !socketPath
        ? `ws://${host}:${listening}${gateway.path}`
        : `ws+unix://${socketPath}${gateway.path}`
      : undefined,
    pairingEnabled: auth.isEnabled(),
    mintConnectCode: (advertiseUrl?: string, label?: string) => auth.mintConnectCode(advertiseUrl, label),
    // `runner.status` is the core's authoritative in-flight signal and already
    // gates `handleChat`; the gateway adds its own in-flight count for turns
    // started over the WebSocket, and `pendingApprovals` covers a turn parked
    // on a human.
    isIdle: () => runner.status === 'idle' && pendingApprovals.size === 0 && (!gatewayRef || gatewayRef.isIdle()),
    setDraining: (value: boolean) => {
      draining = value;
      gatewayRef?.setDraining(value);
    },
    setUpdateHooks: (hooks: UpdateHooks) => {
      updateHooks = hooks;
    },
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
