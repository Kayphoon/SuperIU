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
  activeProviderId: string;
  providers: PersistedProvider[];
}

/** The provider rows `settingsView()` serves to the renderer. */
interface ProviderView {
  id: string;
  enabled: boolean;
  apiKeyMasked: string;
  apiKeySet: boolean;
  baseURL: string;
}

/** An OpenAI-compatible `/models` endpoint that records what each request carried. */
async function startProbeServer(probes: Probe[]) {
  const server = http.createServer((req, res) => {
    probes.push({ path: req.url ?? '', authorization: req.headers.authorization ?? null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'probe-model' }] }));
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

runWireTests().catch((err) => {
  console.error('Wire verification failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
