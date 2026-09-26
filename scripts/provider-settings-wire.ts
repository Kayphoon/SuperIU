/**
 * Wire verification for the multi-provider settings surface
 * (`packages/ui/src/server.ts`).
 *
 * Every assertion here is on the bytes that actually leave the process — the
 * `Authorization` header a probe endpoint receives — or on the settings file the
 * server persists. Asserting on a response body cannot distinguish a leaked
 * credential from a working probe, and the defects guarded here are exactly of
 * that shape:
 *
 *   1. POST /api/models/fetch must never fall back to a stored credential for a
 *      caller-supplied endpoint it does not own. The console is unauthenticated,
 *      so any local process could otherwise exfiltrate the configured key.
 *   2. An unknown endpoint gets an ANONYMOUS probe (no `Authorization` at all),
 *      which is the only way a keyless local endpoint (Ollama, a bare relay)
 *      works before it has ever been saved.
 *   3. POST /api/settings must project the top-level apiKey/baseURL from the
 *      active provider unconditionally, so switching to a keyless provider
 *      reports "unconfigured" instead of sending the previous key to the new
 *      endpoint.
 *   4. Deleting the active provider must not leave a dangling `activeProviderId`.
 *
 * Run: node scripts/provider-settings-wire.ts
 */
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { startServer } from '../packages/ui/dist/server.js';

const ALPHA_KEY = 'sk-alpha-key-1111';
const BETA_KEY = 'sk-beta-key-2222';
const TOP_LEVEL_KEY = 'sk-active-top-level-key';
const EXPLICIT_KEY = 'sk-explicit-key-3333';

let failures = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function test(name: string, fn: () => Promise<void> | void) {
  process.stdout.write(`▶ ${name}...\n`);
  try {
    await fn();
    process.stdout.write(`  ✔ ${name}\n`);
  } catch (err: unknown) {
    failures++;
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`  ✖ ${name}: ${message}\n`);
  }
}

interface Probe {
  path: string;
  authorization: string | null;
  /**
   * The parsed request body, for the endpoints whose payload this suite reasons
   * about. The capability gate's whole job is to decide whether
   * `reasoning_effort` leaves the process, and no response body can show that —
   * a gateway that ignores an unknown parameter answers 200 exactly like one
   * that honours it. Only the outgoing bytes can distinguish the two.
   */
  body: Record<string, unknown> | null;
}

/** The shape `persistSettings()` writes — mirrored so assertions are typed. */
interface PersistedProvider {
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

interface PersistedSettings {
  apiKey: string;
  baseURL: string;
  modelName: string;
  reasoningEffort: string;
  activeProviderId: string;
  providers: PersistedProvider[];
}

/** One row of `/api/settings`'s `modelMetadata`. */
interface ModelMetadataView {
  vision: boolean;
  tools: boolean;
  contextLimit: number;
  formattedContext: string;
}

/**
 * Read one `modelMetadata` row from a settings view.
 *
 * `/api/settings` is an unvalidated JSON boundary, so the fields the assertions
 * rely on are checked here rather than cast at each use — a cast would let a
 * renamed field read as `undefined` and make the assertion silently pass on a
 * missing value.
 */
function modelMetadataRow(view: Record<string, unknown>, model: string): ModelMetadataView {
  const table = view.modelMetadata;
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    throw new Error(`modelMetadata missing from /api/settings: ${JSON.stringify(view).slice(0, 200)}`);
  }
  const row = (table as Record<string, unknown>)[model];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`modelMetadata has no row for '${model}'`);
  }
  const candidate = row as Record<string, unknown>;
  const { vision, tools, contextLimit, formattedContext } = candidate;
  if (
    typeof vision !== 'boolean' ||
    typeof tools !== 'boolean' ||
    typeof contextLimit !== 'number' ||
    typeof formattedContext !== 'string'
  ) {
    throw new Error(`modelMetadata['${model}'] has the wrong shape: ${JSON.stringify(row)}`);
  }
  return { vision, tools, contextLimit, formattedContext };
}

/** The provider rows `settingsView()` serves to the renderer. */
interface ProviderView {
  id: string;
  enabled: boolean;
  apiKeyMasked: string;
  apiKeySet: boolean;
  baseURL: string;
}

/**
 * Prompt tokens the probe reports for every chat completion it serves.
 *
 * 500,000 is a clean 50% of the 1M window that `gemini-3.8-flash` and
 * `deepseek-flash` share, and it is comfortably above `o3-mini`'s 200K so the
 * same fixture still exercises the percentage clamp.
 */
const PROBE_PROMPT_TOKENS = 500_000;

/**
 * An OpenAI-compatible endpoint that records what each request carried, and
 * answers `/chat/completions` with a one-step SSE stream that reports usage.
 * Serving usage is what makes the context meter observable end-to-end: the
 * number travels provider → adapter → engine → `/api/status` and the `done`
 * frame, and asserting on any one hop alone would not prove the chain.
 */
async function startProbeServer(probes: Probe[]) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      let body: Record<string, unknown> | null = null;
      if (raw) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = null;
        }
      }
      probes.push({ path: req.url ?? '', authorization: req.headers.authorization ?? null, body });

      if ((req.url ?? '').endsWith('/chat/completions')) {
        const frame = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>) =>
          `data: ${JSON.stringify({
            id: 'chatcmpl-probe',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'probe-model',
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(usage ? { usage } : {})
          })}\n\n`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(frame({ role: 'assistant', content: 'probe answer' }, null));
        res.write(
          frame({}, 'stop', {
            prompt_tokens: PROBE_PROMPT_TOKENS,
            completion_tokens: 4,
            total_tokens: PROBE_PROMPT_TOKENS + 4
          })
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'probe-model' }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('probe server did not bind a TCP port');
  }
  return {
    origin: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

/**
 * Point the ACTIVE provider at the probe's endpoint and offer `models` on it.
 *
 * The runner's credential and endpoint are a projection of the active provider,
 * so writing the probe's origin into that entry is the only way to drive a real
 * turn end-to-end: without it the turn leaves for a real host and the meter
 * falls back to an estimate, which would make the usage assertions vacuous.
 */
async function seedProbeProvider(baseUrl: string, origin: string, models: string[]): Promise<void> {
  const view = await requestJson(`${baseUrl}/api/settings`);
  if (!Array.isArray(view.providers)) {
    throw new Error(`/api/settings served no providers: ${JSON.stringify(view).slice(0, 200)}`);
  }
  const provider = providerEntry('probe', origin, ALPHA_KEY);
  await postJson(`${baseUrl}/api/settings`, {
    activeProviderId: 'probe',
    providers: [{ ...provider, models }]
  });
}

/** One SSE frame set from a `/api/chat` response body. */
function parseSseFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data:'))
    .map((block) => JSON.parse(block.slice('data:'.length).trim()) as Record<string, unknown>);
}

/** Stream one turn and return the terminal `done` frame. */
async function runTurnAndReadDone(baseUrl: string, prompt: string): Promise<Record<string, unknown>> {
  const resp = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt })
  });
  const frames = parseSseFrames(await resp.text());
  const done = frames.find((frame) => frame.type === 'done');
  if (!done) {
    throw new Error(`no done frame: ${JSON.stringify(frames).slice(0, 300)}`);
  }
  return done;
}

async function requestJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const resp = await fetch(url, init);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} from ${url}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  return requestJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

/** The last probe whose path ends with `suffix` — one per fetch call. */
function lastProbe(probes: Probe[], suffix: string): Probe {
  const hit = [...probes].reverse().find((probe) => probe.path.endsWith(suffix));
  if (!hit) {
    throw new Error(`no probe request ended with '${suffix}'; saw ${probes.map((p) => p.path).join(', ') || '(none)'}`);
  }
  return hit;
}

function providerEntry(id: string, baseURL: string, apiKey: string, enabled = false) {
  return {
    id,
    name: id,
    enabled,
    apiKey,
    baseURL,
    models: [],
    description: '',
    helpUrl: '',
    custom: id === 'keyless'
  };
}

/**
 * Preset-catalog migration: a settings file written before the current catalog
 * must have its shipped model lists moved forward, while any user edit survives.
 *
 * Each case boots its own server against its own file, because the migration
 * happens in `loadSettings()` and a shared boot would only exercise it once.
 */
async function runMigrationTests() {
  console.log('=== Preset catalog migration verification ===\n');

  /** Boot a server over `providers` and return the provider rows it serves. */
  const boot = async (providers: unknown[]) => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'superiu-migration-'));
    const settingsFile = path.join(sandbox, '.myagent', 'ui-settings.json');
    await fs.mkdir(path.dirname(settingsFile), { recursive: true });
    // `startServer` resolves its session/memory dirs from the process cwd while
    // settings come from `workspaceDir`, so anchor both to the sandbox — a stray
    // `.myagent/` must never land in the repository.
    const origin = process.cwd();
    process.chdir(sandbox);
    const written = `${JSON.stringify(
      {
        apiKey: TOP_LEVEL_KEY,
        baseURL: 'https://api.openai.com/v1',
        modelName: 'gpt-4o',
        reviewModelName: 'gpt-4o-mini',
        autoReview: true,
        reasoningEffort: '',
        language: 'en',
        activeProviderId: 'openai',
        providers
      },
      null,
      2
    )}\n`;
    await fs.writeFile(settingsFile, written, 'utf-8');

    const handle = await startServer({ port: 0, workspaceDir: sandbox, settingsFile, quiet: true });
    const onDisk = await fs.readFile(settingsFile, 'utf-8');
    const view = await requestJson(`${handle.url}/api/settings`);
    const rows = (view.providers as Array<Record<string, unknown>>) ?? [];
    return {
      rows,
      onDisk,
      written,
      close: async () => {
        await handle.close();
        process.chdir(origin);
        await fs.rm(sandbox, { recursive: true, force: true });
      }
    };
  };

  const presetRow = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    name: id,
    enabled: id === 'openai',
    apiKey: `${id}-key`,
    baseURL: `https://${id}.example/v1`,
    models: [],
    description: '',
    helpUrl: `https://${id}.example/keys`,
    custom: false,
    ...over
  });

  const LEGACY = {
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini', 'o1'],
    gemini: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    anthropic: ['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022']
  };
  const CURRENT = {
    openai: ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-4o', 'gpt-4.1'],
    gemini: ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
    anthropic: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5']
  };

  await test('an old exact preset model list is refreshed to the current catalog', async () => {
    const h = await boot([
      presetRow('openai', { models: LEGACY.openai }),
      presetRow('gemini', { models: LEGACY.gemini }),
      presetRow('deepseek', { models: LEGACY.deepseek }),
      presetRow('anthropic', { models: LEGACY.anthropic })
    ]);
    try {
      for (const id of ['openai', 'gemini', 'deepseek', 'anthropic'] as const) {
        const row = h.rows.find((r) => r.id === id);
        assert(row, `provider '${id}' vanished during load`);
        assert(
          JSON.stringify(row.models) === JSON.stringify(CURRENT[id]),
          `'${id}' models are ${JSON.stringify(row.models)}, expected ${JSON.stringify(CURRENT[id])}`
        );
      }
    } finally {
      await h.close();
    }
  });

  await test('a user-customized model list is left byte-identical', async () => {
    // Three independent ways to differ from the shipped list: one id added, one
    // removed, and a reorder that keeps the same members. All three are edits.
    const added = [...LEGACY.gemini, 'my-private-model'];
    const removed = LEGACY.gemini.slice(0, -1);
    const reordered = [...LEGACY.gemini].reverse();
    const h = await boot([
      presetRow('gemini', { models: added }),
      presetRow('deepseek', { models: removed }),
      presetRow('anthropic', { models: reordered })
    ]);
    try {
      const expected: Array<[string, string[]]> = [
        ['gemini', added],
        ['deepseek', removed],
        ['anthropic', reordered]
      ];
      for (const [id, models] of expected) {
        const row = h.rows.find((r) => r.id === id);
        assert(row, `provider '${id}' vanished during load`);
        assert(
          JSON.stringify(row.models) === JSON.stringify(models),
          `'${id}' was migrated over a user edit: ${JSON.stringify(row.models)} != ${JSON.stringify(models)}`
        );
      }
    } finally {
      await h.close();
    }
  });

  await test('a custom provider and an id with no preset row are untouched', async () => {
    const customModels = ['local-llama', 'another-local'];
    const h = await boot([
      presetRow('custom', { models: customModels, custom: true, name: 'My gateway' }),
      presetRow('my-relay', { models: LEGACY.openai, custom: true })
    ]);
    try {
      const custom = h.rows.find((r) => r.id === 'custom');
      assert(custom, 'the custom provider vanished during load');
      assert(
        JSON.stringify(custom.models) === JSON.stringify(customModels),
        `the custom provider's models were touched: ${JSON.stringify(custom.models)}`
      );
      // A non-preset id carrying the OLD openai list verbatim still must not be
      // rewritten: the table is keyed by preset id, and this id has no row.
      const relay = h.rows.find((r) => r.id === 'my-relay');
      assert(relay, 'the unknown-id provider vanished during load');
      assert(
        JSON.stringify(relay.models) === JSON.stringify(LEGACY.openai),
        `an id with no preset row was migrated: ${JSON.stringify(relay.models)}`
      );
    } finally {
      await h.close();
    }
  });

  await test('only models move: name, apiKey and baseURL survive the migration', async () => {
    const h = await boot([
      presetRow('gemini', {
        models: LEGACY.gemini,
        name: 'My Gemini',
        apiKey: 'sk-gemini-secret',
        baseURL: 'https://my-proxy.example/v1',
        description: 'hand written',
        helpUrl: 'https://my-proxy.example/help'
      })
    ]);
    try {
      const row = h.rows.find((r) => r.id === 'gemini');
      assert(row, 'the gemini provider vanished during load');
      assert(
        JSON.stringify(row.models) === JSON.stringify(CURRENT.gemini),
        `models were not refreshed: ${JSON.stringify(row.models)}`
      );
      assert(row.name === 'My Gemini', `name changed to '${String(row.name)}'`);
      assert(
        row.apiKeyMasked === 'sk-ge••••cret',
        `apiKey changed: '${String(row.apiKeyMasked)}'`
      );
      assert(row.baseURL === 'https://my-proxy.example/v1', `baseURL changed to '${String(row.baseURL)}'`);
      assert(row.description === 'hand written', `description changed to '${String(row.description)}'`);
      assert(row.helpUrl === 'https://my-proxy.example/help', `helpUrl changed to '${String(row.helpUrl)}'`);
    } finally {
      await h.close();
    }
  });

  await test('the migration does not write to disk on its own', async () => {
    // Loading is not persisting: a read-only boot must leave the file exactly as
    // written, or merely opening the console would rewrite the user's settings.
    const h = await boot([presetRow('gemini', { models: LEGACY.gemini })]);
    try {
      assert(
        h.onDisk === h.written,
        'loadSettings() rewrote the settings file; the migration must stay in memory until the next persist'
      );
    } finally {
      await h.close();
    }
  });

  console.log();
  if (failures > 0) {
    throw new Error(`${failures} migration test(s) failed`);
  }
  console.log('=== All preset catalog migration tests passed ===');
}

async function runWireTests() {
  console.log('=== Provider settings wire verification ===\n');

  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'superiu-provider-wire-'));
  const settingsFile = path.join(sandbox, '.myagent', 'ui-settings.json');
  const probes: Probe[] = [];
  const probe = await startProbeServer(probes);
  /** Probe indexes at which the caller supplied the credential itself. */
  const callerSupplied = new Set<number>();

  // `startServer` resolves its memory/history dirs from the process cwd while
  // settings come from `workspaceDir`, so anchor both to the sandbox — a stray
  // `.myagent/` must never land in the repository.
  process.chdir(sandbox);

  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  await fs.writeFile(
    settingsFile,
    `${JSON.stringify(
      {
        apiKey: TOP_LEVEL_KEY,
        baseURL: `${probe.origin}/active`,
        modelName: 'probe-model',
        reviewModelName: 'probe-model',
        autoReview: false,
        reasoningEffort: '',
        language: 'en',
        activeProviderId: 'alpha',
        providers: [
          providerEntry('alpha', `${probe.origin}/alpha`, ALPHA_KEY, true),
          providerEntry('beta', `${probe.origin}/beta`, BETA_KEY),
          providerEntry('keyless', `${probe.origin}/keyless`, '')
        ]
      },
      null,
      2
    )}\n`,
    'utf-8'
  );

  const readSettingsFile = async (): Promise<PersistedSettings> =>
    JSON.parse(await fs.readFile(settingsFile, 'utf-8')) as PersistedSettings;

  const handle = await startServer({ port: 0, workspaceDir: sandbox, settingsFile, quiet: true });

  try {
    const fetchModels = (body: Record<string, unknown>) =>
      postJson(`${handle.url}/api/models/fetch`, body);

    // -------------------------------------------------------------------------
    // Credential resolution, proven on the wire
    // -------------------------------------------------------------------------
    await test('unknown endpoint with no apiKey gets an ANONYMOUS probe', async () => {
      const before = probes.length;
      const result = await fetchModels({ baseURL: `${probe.origin}/nowhere` });
      assert(result.ok === true, `probe failed: ${JSON.stringify(result)}`);
      const hit = lastProbe(probes.slice(before), '/nowhere/models');
      assert(
        hit.authorization === null,
        `expected no Authorization header, got '${hit.authorization}'`
      );
    });

    await test('endpoint owned by a provider uses THAT provider key', async () => {
      const before = probes.length;
      await fetchModels({ baseURL: `${probe.origin}/alpha` });
      const hit = lastProbe(probes.slice(before), '/alpha/models');
      assert(
        hit.authorization === `Bearer ${ALPHA_KEY}`,
        `expected the alpha key, got '${hit.authorization}'`
      );
    });

    await test('a non-active provider key is never swapped for the active one', async () => {
      const before = probes.length;
      await fetchModels({ baseURL: `${probe.origin}/beta` });
      const hit = lastProbe(probes.slice(before), '/beta/models');
      assert(
        hit.authorization === `Bearer ${BETA_KEY}`,
        `expected the beta key, got '${hit.authorization}'`
      );
    });

    await test('a keyless provider endpoint stays anonymous (no top-level fallback)', async () => {
      const before = probes.length;
      await fetchModels({ baseURL: `${probe.origin}/keyless` });
      const hit = lastProbe(probes.slice(before), '/keyless/models');
      assert(
        hit.authorization === null,
        `a keyless endpoint must not borrow a credential, got '${hit.authorization}'`
      );
    });

    await test('the active settings.baseURL may use the top-level key', async () => {
      const before = probes.length;
      await fetchModels({ baseURL: `${probe.origin}/active` });
      const hit = lastProbe(probes.slice(before), '/active/models');
      assert(
        hit.authorization === `Bearer ${TOP_LEVEL_KEY}`,
        `expected the top-level key for its own endpoint, got '${hit.authorization}'`
      );
    });

    await test('an explicitly supplied apiKey is sent verbatim', async () => {
      const before = probes.length;
      await fetchModels({ baseURL: `${probe.origin}/nowhere`, apiKey: EXPLICIT_KEY });
      const hit = lastProbe(probes.slice(before), '/nowhere/models');
      assert(
        hit.authorization === `Bearer ${EXPLICIT_KEY}`,
        `expected the explicit key, got '${hit.authorization}'`
      );
      // Caller-supplied credentials are the one legitimate way a key reaches an
      // endpoint that does not own it, so the global invariant below excludes
      // exactly this request — and nothing else.
      callerSupplied.add(before);
    });

    await test('a masked apiKey is treated as absent, never sent literally', async () => {
      const before = probes.length;
      await fetchModels({ baseURL: `${probe.origin}/nowhere`, apiKey: 'sk-no••••9999' });
      const hit = lastProbe(probes.slice(before), '/nowhere/models');
      assert(
        hit.authorization === null,
        `a masked stub must not be transmitted, got '${hit.authorization}'`
      );

      const maskedKnown = probes.length;
      await fetchModels({ baseURL: `${probe.origin}/alpha`, apiKey: 'sk-al••••1111' });
      const ownerHit = lastProbe(probes.slice(maskedKnown), '/alpha/models');
      assert(
        ownerHit.authorization === `Bearer ${ALPHA_KEY}`,
        `a masked stub must fall back to the endpoint's own key, got '${ownerHit.authorization}'`
      );
    });

    await test('GET /api/models never hands out a credential', async () => {
      const view = await requestJson(`${handle.url}/api/models`);
      const serialized = JSON.stringify(view);
      assert(!serialized.includes('sk-'), `a credential-shaped string was served: ${serialized}`);
      assert(view.main !== undefined, `unexpected /api/models shape: ${serialized}`);
    });

    await test('no probe ever received a credential it does not own', async () => {
      // The whole surface in one assertion: for every request that left the
      // process, the credential sent is the one belonging to the endpoint the
      // request targeted — or nothing at all. A leak is any key arriving at an
      // endpoint other than its owner's.
      const owners: Record<string, string | null> = {
        '/alpha/models': `Bearer ${ALPHA_KEY}`,
        '/beta/models': `Bearer ${BETA_KEY}`,
        '/keyless/models': null,
        '/active/models': `Bearer ${TOP_LEVEL_KEY}`,
        '/nowhere/models': null
      };
      const mismatches = probes
        .map((probe, index) => {
          if (callerSupplied.has(index)) return null;
          const suffix = Object.keys(owners).find((path) => probe.path.endsWith(path));
          if (!suffix) return `${probe.path} → ${probe.authorization}`;
          return probe.authorization === owners[suffix]
            ? null
            : `${probe.path} → ${probe.authorization} (expected ${owners[suffix]})`;
        })
        .filter(Boolean);
      assert(mismatches.length === 0, mismatches.join('; '));
    });

    // -------------------------------------------------------------------------
    // Projection invariants, proven through /api/settings
    // -------------------------------------------------------------------------
    await test('switching to a keyless provider projects an empty credential', async () => {
      const view = await postJson(`${handle.url}/api/settings`, { activeProviderId: 'keyless' });
      assert(view.apiKeySet === false, `expected apiKeySet false, got ${view.apiKeySet}`);
      assert(view.apiKeyMasked === '', `expected an empty mask, got '${view.apiKeyMasked}'`);
      assert(
        view.baseURL === `${probe.origin}/keyless`,
        `baseURL did not follow the provider: ${view.baseURL}`
      );
      assert(view.activeProviderId === 'keyless', `active id is ${view.activeProviderId}`);

      const persisted = await readSettingsFile();
      assert(persisted.apiKey === '', `persisted apiKey is '${persisted.apiKey}', not empty`);
      assert(
        persisted.baseURL === `${probe.origin}/keyless`,
        `persisted baseURL is '${persisted.baseURL}'`
      );
      const alpha = persisted.providers.find((p) => p.id === 'alpha');
      assert(
        alpha?.apiKey === ALPHA_KEY,
        `the previous provider's own credential was clobbered: '${alpha?.apiKey}'`
      );
    });

    await test('switching back restores the provider credential', async () => {
      const view = await postJson(`${handle.url}/api/settings`, { activeProviderId: 'alpha' });
      assert(view.apiKeySet === true, 'the alpha credential did not come back');
      const persisted = await readSettingsFile();
      assert(persisted.apiKey === ALPHA_KEY, `persisted apiKey is '${persisted.apiKey}'`);
      const enabled = persisted.providers.filter((p) => p.enabled).map((p) => p.id);
      assert(
        enabled.length === 1 && enabled[0] === 'alpha',
        `expected exactly alpha enabled, saw ${JSON.stringify(enabled)}`
      );
    });

    await test('a top-level apiKey in the same patch cannot override the projection', async () => {
      const view = await postJson(`${handle.url}/api/settings`, {
        activeProviderId: 'beta',
        apiKey: 'sk-injected-should-be-ignored',
        baseURL: 'http://evil.example/v1',
        providers: [
          providerEntry('alpha', `${probe.origin}/alpha`, ''),
          providerEntry('beta', `${probe.origin}/beta`, 'sk-be••••2222'),
          providerEntry('keyless', `${probe.origin}/keyless`, '')
        ]
      });
      assert(
        view.baseURL === `${probe.origin}/beta`,
        `the injected baseURL won: ${view.baseURL}`
      );
      const persisted = await readSettingsFile();
      assert(persisted.apiKey === BETA_KEY, `persisted apiKey is '${persisted.apiKey}'`);
      assert(
        persisted.providers.find((p) => p.id === 'alpha')?.apiKey === ALPHA_KEY,
        'the empty draft value clobbered a stored credential'
      );
      assert(
        persisted.providers.find((p) => p.id === 'beta')?.apiKey === BETA_KEY,
        'the masked draft value clobbered a stored credential'
      );
    });

    await test('deleting the active provider falls back without dangling', async () => {
      const view = await postJson(`${handle.url}/api/settings`, {
        activeProviderId: 'alpha',
        providers: [
          providerEntry('beta', `${probe.origin}/beta`, ''),
          providerEntry('keyless', `${probe.origin}/keyless`, '')
        ]
      });
      assert(
        view.activeProviderId === 'beta',
        `expected the first survivor, got '${view.activeProviderId}'`
      );
      assert(
        (view.providers as ProviderView[]).some((p) => p.id === view.activeProviderId),
        'activeProviderId matches no provider — it dangles'
      );
      assert(
        view.baseURL === `${probe.origin}/beta`,
        `projection did not follow the fallback: ${view.baseURL}`
      );
      const persisted = await readSettingsFile();
      assert(persisted.apiKey === BETA_KEY, `persisted apiKey is '${persisted.apiKey}'`);
    });

    await test('an empty provider table clears the id instead of dangling', async () => {
      const view = await postJson(`${handle.url}/api/settings`, { providers: [] });
      assert(view.activeProviderId === 'openai', `view fell back to '${view.activeProviderId}'`);
      const persisted = await readSettingsFile();
      assert(persisted.activeProviderId === '', `persisted id is '${persisted.activeProviderId}'`);
      assert(persisted.apiKey === '', `persisted apiKey is '${persisted.apiKey}'`);
    });

    // -------------------------------------------------------------------------
    // Context usage + model metadata over the wire
    //
    // The meter's number is only correct if every hop preserves it, so these
    // assertions run against a real provider stream: the probe reports
    // `prompt_tokens`, and the value must arrive unchanged on `/api/status` and
    // in the SSE `done` frame, divided by the window belonging to the model the
    // runner is actually configured with.
    // -------------------------------------------------------------------------
    const probeModels = ['gemini-3.8-flash', 'gemini-1.5-flash', 'o3-mini', 'deepseek-flash'];
    await seedProbeProvider(handle.url, probe.origin, probeModels);

    await test('POST /api/settings accepts modelName, reasoningEffort and activeProviderId together', async () => {
      const view = await postJson(`${handle.url}/api/settings`, {
        activeProviderId: 'probe',
        modelName: 'gemini-3.8-flash',
        reasoningEffort: 'high'
      });
      assert(view.modelName === 'gemini-3.8-flash', `modelName not applied: ${view.modelName}`);
      assert(view.reasoningEffort === 'high', `reasoningEffort not applied: ${view.reasoningEffort}`);
      assert(view.activeProviderId === 'probe', `activeProviderId not applied: ${view.activeProviderId}`);
      assert(view.restarted === true, 'the model change did not rebuild the runner');
      assert(
        view.baseURL === probe.origin,
        `the active provider's endpoint was not projected: ${String(view.baseURL)}`
      );

      const persisted = await readSettingsFile();
      assert(persisted.modelName === 'gemini-3.8-flash', `persisted modelName ${persisted.modelName}`);
      assert(persisted.reasoningEffort === 'high', `persisted reasoningEffort ${persisted.reasoningEffort}`);
      assert(persisted.apiKey === ALPHA_KEY, `projection lost: ${persisted.apiKey}`);
    });

    await test('GET /api/settings exposes per-model capability metadata', async () => {
      const view = await requestJson(`${handle.url}/api/settings`);
      const gemini = modelMetadataRow(view, 'gemini-3.8-flash');
      assert(gemini.contextLimit === 1_000_000, `gemini-3.8-flash window ${gemini.contextLimit}`);
      assert(gemini.formattedContext === '1M', `formattedContext is '${gemini.formattedContext}'`);
      assert(gemini.vision === true, 'gemini-3.8-flash reported no vision');
      assert(gemini.tools === true, 'gemini-3.8-flash reported no tools');
      assert(modelMetadataRow(view, 'deepseek-flash').formattedContext === '1M', 'deepseek-flash is not 1M');
      assert(modelMetadataRow(view, 'gpt-4o').contextLimit === 128_000, 'gpt-4o window is not 128K');
      // A model the user typed into a provider's list must be covered too: it is
      // exactly the case the meter cannot fall back to the default for.
      const configured = view.modelName;
      assert(typeof configured === 'string' && configured.length > 0, 'modelName missing from the view');
      modelMetadataRow(view, configured);
    });

    await test('a real turn reports the provider context count on /api/status and in the done frame', async () => {
      const before = probes.length;
      const done = await runTurnAndReadDone(handle.url, 'measure the window');
      assert(
        done.contextTokens === PROBE_PROMPT_TOKENS,
        `done.contextTokens is ${String(done.contextTokens)}, expected ${PROBE_PROMPT_TOKENS}`
      );
      assert(done.contextLimit === 1_000_000, `done.contextLimit is ${String(done.contextLimit)}`);
      assert(done.contextPercent === 50, `done.contextPercent is ${String(done.contextPercent)}`);

      const status = await requestJson(`${handle.url}/api/status`);
      assert(
        status.contextTokens === PROBE_PROMPT_TOKENS,
        `status.contextTokens is ${String(status.contextTokens)}`
      );
      assert(status.contextLimit === 1_000_000, `status.contextLimit is ${String(status.contextLimit)}`);
      assert(status.contextPercent === 50, `status.contextPercent is ${String(status.contextPercent)}`);
      assert(
        Number.isInteger(status.contextPercent),
        `contextPercent is not an integer: ${String(status.contextPercent)}`
      );
      // Gemini's OpenAI-compatibility endpoint documents `reasoning_effort`, so
      // the configured `high` must now be in force on the main route rather than
      // stripped by the capability gate.
      assert(
        status.reasoningEffort === 'high',
        `gemini-3.8-flash did not report the configured effort: '${String(status.reasoningEffort)}'`
      );
      // The status field alone cannot show the parameter left the process: a
      // gateway that ignores an unknown parameter answers 200 exactly like one
      // that honours it. This is the outgoing payload.
      const turn = lastProbe(probes.slice(before), '/chat/completions');
      assert(
        turn.body?.reasoning_effort === 'high',
        `the request carried reasoning_effort '${String(turn.body?.reasoning_effort)}'`
      );
      assert(turn.body?.model === 'gemini-3.8-flash', `request model '${String(turn.body?.model)}'`);
      // `high` also scales the budget (2048 × 4), so the same payload proves the
      // effort reached the route rather than only the status string.
      assert(
        turn.body?.max_tokens === 8192,
        `the request carried max_tokens ${String(turn.body?.max_tokens)}, expected 8192`
      );
    });

    await test('a model outside the allowlist is sent no reasoning_effort at all', async () => {
      // The negative control for the gate, and the reason it is an allowlist:
      // an older Gemini tier rejects the parameter, so a pattern that were a
      // catch-all would turn every turn on it into an HTTP 400. Switching the
      // route keeps the same configured `high` in settings, which isolates the
      // model as the only variable.
      await postJson(`${handle.url}/api/model`, { role: 'main', model: 'gemini-1.5-flash' });
      const status = await requestJson(`${handle.url}/api/status`);
      assert(status.model === 'gemini-1.5-flash', `model did not switch: ${String(status.model)}`);
      assert(
        status.reasoningEffort === '',
        `gemini-1.5-flash reported effort '${String(status.reasoningEffort)}'`
      );

      const before = probes.length;
      await runTurnAndReadDone(handle.url, 'a tier that rejects the parameter');
      const turn = lastProbe(probes.slice(before), '/chat/completions');
      assert(turn.body?.model === 'gemini-1.5-flash', `request model '${String(turn.body?.model)}'`);
      assert(
        !('reasoning_effort' in (turn.body ?? {})),
        `the request carried reasoning_effort ${String(turn.body?.reasoning_effort)} to a model that rejects it`
      );
      // The configured `high` is still in settings, so the budget is what the
      // gate must strip along with the effort: 2048 unscaled, not the 8192 the
      // accepting tier above carried. Without this the test would also pass if
      // the effort were merely hidden from the status field.
      assert(
        turn.body?.max_tokens === 2048,
        `the request carried max_tokens ${String(turn.body?.max_tokens)}, expected the unscaled 2048`
      );
    });

    await test('a reasoning model reports the effort in force and clamps a full window', async () => {
      await postJson(`${handle.url}/api/settings`, { modelName: 'o3-mini', reasoningEffort: 'high' });
      const status = await requestJson(`${handle.url}/api/status`);
      assert(status.reasoningEffort === 'high', `status.reasoningEffort is '${String(status.reasoningEffort)}'`);
      assert(status.contextLimit === 200_000, `o3-mini window is ${String(status.contextLimit)}`);

      // The probe reports more tokens than o3-mini's window holds. A percentage
      // above 100 would overflow any progress bar, so it must clamp.
      const done = await runTurnAndReadDone(handle.url, 'overflow the window');
      assert(done.contextTokens === PROBE_PROMPT_TOKENS, `done.contextTokens ${String(done.contextTokens)}`);
      assert(done.contextLimit === 200_000, `done.contextLimit ${String(done.contextLimit)}`);
      assert(done.contextPercent === 100, `percent was not clamped: ${String(done.contextPercent)}`);
    });

    await test('switching to a 1M model rescales the same token count', async () => {
      // The numerator is unchanged; only the window moves. A meter that cached
      // the percentage would keep showing 100% on a 1M model.
      //
      // Deliberately `POST /api/model` rather than `POST /api/settings`: the
      // former switches the route at runtime and keeps the engine's last usage,
      // so this isolates the divisor. A settings patch rebuilds the runner and
      // would clear the measurement, which is a different (also covered) path.
      await postJson(`${handle.url}/api/model`, { role: 'main', model: 'deepseek-flash' });
      const status = await requestJson(`${handle.url}/api/status`);
      assert(status.model === 'deepseek-flash', `model did not switch: ${String(status.model)}`);
      assert(
        status.contextTokens === PROBE_PROMPT_TOKENS,
        `the runtime switch dropped the measurement: ${String(status.contextTokens)}`
      );
      assert(status.contextLimit === 1_000_000, `limit did not follow the model: ${String(status.contextLimit)}`);
      assert(status.contextPercent === 50, `percent did not rescale: ${String(status.contextPercent)}`);
    });

    await test('a settings rebuild falls back to estimating the resumed branch', async () => {
      // The rebuild path is the counterpart of the runtime switch above: a new
      // runner has no provider usage, so the meter must estimate the branch it
      // reopened rather than report an empty context for a conversation that is
      // plainly not empty.
      await postJson(`${handle.url}/api/settings`, { modelName: 'gemini-3.8-flash' });
      const status = await requestJson(`${handle.url}/api/status`);
      const messageCount = status.messageCount;
      assert(typeof messageCount === 'number' && messageCount > 0, 'the rebuilt runner lost the session');
      const tokens = status.contextTokens;
      assert(typeof tokens === 'number' && Number.isFinite(tokens), `non-finite tokens: ${String(tokens)}`);
      assert(tokens > 0, 'a resumed session with messages estimated zero tokens');
      assert(tokens < PROBE_PROMPT_TOKENS, `the estimate reused a stale provider count: ${tokens}`);
    });
  } finally {
    await handle.close();
    await probe.close();
    await fs.rm(sandbox, { recursive: true, force: true });
  }

  console.log();
  if (failures > 0) {
    throw new Error(`${failures} wire test(s) failed`);
  }
  console.log('=== All provider settings wire tests passed ===');
}

async function main() {
  await runMigrationTests();
  await runWireTests();
}

main().catch((err) => {
  console.error('Wire verification failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
