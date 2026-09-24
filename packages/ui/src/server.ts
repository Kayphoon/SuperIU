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
  parseReasoningEffort,
  resolveMemoryDir,
  supportsReasoningEffort,
  type ContextMessage,
  type EmotionState,
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
  /** Idempotent: resolves pending approvals, closes the HTTP server and the agent runner. */
  close(): Promise<void>;
}

// Resolved by startServer so the module can be imported without side effects.
let PUBLIC_DIR = path.resolve(HERE, '..', 'public');
let SETTINGS_FILE = path.join(process.cwd(), '.myagent', 'ui-settings.json');

/** Models offered in the secondary menu's model selector; free-text entry is also accepted. */
const MODEL_CHOICES: string[] = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4.1',
  'claude-3-5-sonnet',
  'claude-3-7-sonnet',
  'deepseek-chat',
  'deepseek-reasoner',
  'qwen-max',
  'moonshot-v1-128k'
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
    language: parseLanguage(process.env.SUPERIU_LANGUAGE) ?? DEFAULT_LANGUAGE
  };

  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) as Partial<UiSettings>;
    return {
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : defaults.apiKey,
      baseURL: typeof raw.baseURL === 'string' ? raw.baseURL : defaults.baseURL,
      modelName: typeof raw.modelName === 'string' && raw.modelName ? raw.modelName : defaults.modelName,
      reviewModelName:
        typeof raw.reviewModelName === 'string' && raw.reviewModelName
          ? raw.reviewModelName
          : defaults.reviewModelName,
      autoReview: typeof raw.autoReview === 'boolean' ? raw.autoReview : defaults.autoReview,
      reasoningEffort: parseReasoningEffort(raw.reasoningEffort) ?? defaults.reasoningEffort,
      // The file is authoritative, but an unknown id (hand-edited or written by
      // a newer build) must not pin the UI to a language it cannot render.
      language: parseLanguage(raw.language) ?? defaults.language
    };
  } catch {
    // Missing or corrupt file: fall back to environment defaults.
    return defaults;
  }
}

function persistSettings(next: UiSettings): void {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
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

function buildStatus() {
  const sessionFile = runner.getSessionFile();
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
    memoryDir,
    settingsFile: SETTINGS_FILE,
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

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function settingsView() {
  return {
    apiKeyMasked: maskApiKey(settings.apiKey),
    apiKeySet: settings.apiKey.length > 0,
    baseURL: settings.baseURL,
    modelName: settings.modelName,
    reviewModelName: settings.reviewModelName,
    autoReview: settings.autoReview,
    language: settings.language,
    /** '' means "derive": env value, else the core default. */
    reasoningEffort: settings.reasoningEffort,
    /** Effort the main route actually resolves to right now (undefined when the model rejects it). */
    reasoningEffortEffective: runner.getModelRoutes().main.reasoningEffort,
    reasoningSupported: supportsReasoningEffort(settings.modelName),
    modelChoices: MODEL_CHOICES,
    settingsFile: SETTINGS_FILE,
    env: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ? 'set' : 'unset',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? '',
      OPENAI_MODEL_NAME: process.env.OPENAI_MODEL_NAME ?? '',
      OPENAI_REVIEW_MODEL_NAME: process.env.OPENAI_REVIEW_MODEL_NAME ?? '',
      OPENAI_REASONING_EFFORT: process.env.OPENAI_REASONING_EFFORT ?? ''
    }
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

    // `language` is presentation-only and never touches the runner, so a patch
    // that carries nothing else must not be gated on an idle agent — otherwise
    // switching the interface language mid-turn fails with a 409 and the UI
    // visibly snaps back. Any other key still requires an idle runner.
    const presentationOnly = Object.keys(body).every((key) => key === 'language');

    if (!presentationOnly && runner.status !== 'idle') {
      sendError(res, 409, `Cannot apply settings while the agent is ${runner.status}. Abort the turn first.`);
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
      sendError(res, 404, errorMessage(err));
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
    sendError(res, 409, `Agent is busy (status: ${runner.status}). Abort or wait for the current turn.`);
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
        write({ type: 'error', message: err.message, phase });
      }
    };
    return target.run(turnPrompt, callbacks, modelOverride ? { model: modelOverride } : {});
  };

  const finish = (finalText: string): void => {
    write({
      type: 'done',
      finalText,
      sessionId: runner.getSessionId(),
      leafId: runner.getLeafId(),
      messageCount: runner.getMessages().length,
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
    if (!errorSent) write({ type: 'error', message: errorMessage(err) });
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
        if (!res.headersSent) {
          sendError(res, 500, errorMessage(err));
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
  return { port: listening, host, url: `http://${host}:${listening}`, language: settings.language, close };
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
