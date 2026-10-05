/**
 * Tests for the settings-file read-modify-write in `@agent/ui`.
 *
 * The SPA owns most of `ui-settings.json`, but the desktop shell stores its own
 * connection/onboarding state in the SAME file. A settings save from the web UI
 * must therefore preserve every key the server does not own — otherwise the
 * onboarding wizard would find its `onboardingCompleted` flag erased and
 * reappear on every launch.
 */

import { describe, it, expect } from 'vitest';
import { mergePersistedSettings } from '../src/server.js';

describe('mergePersistedSettings', () => {
  it('preserves foreign desktop keys across a settings save', () => {
    const raw = {
      apiKey: 'sk-old',
      baseURL: 'https://api.openai.com/v1',
      connectionMode: 'remote',
      remote: { alias: 'vps', workspace: '/srv/superiu' },
      onboardingCompleted: true
    };
    const next = {
      apiKey: 'sk-new',
      baseURL: 'https://api.anthropic.com/v1',
      modelName: 'claude-sonnet-5'
    };

    const merged = mergePersistedSettings(raw, next);

    expect(merged.connectionMode).toBe('remote');
    expect(merged.remote).toEqual({ alias: 'vps', workspace: '/srv/superiu' });
    expect(merged.onboardingCompleted).toBe(true);
  });

  it('lets an owned key in next override the stored value', () => {
    const raw = { apiKey: 'sk-stored', baseURL: 'https://old.example/v1' };
    const next = { apiKey: 'sk-fresh', baseURL: 'https://new.example/v1' };

    const merged = mergePersistedSettings(raw, next);

    expect(merged.apiKey).toBe('sk-fresh');
    expect(merged.baseURL).toBe('https://new.example/v1');
  });

  it('never resurrects a foreign key absent from raw', () => {
    const raw = { apiKey: 'sk-stored' };
    const next = { apiKey: 'sk-fresh', modelName: 'gpt-5.6-luna' };

    const merged = mergePersistedSettings(raw, next);

    expect(Object.keys(merged).sort()).toEqual(['apiKey', 'modelName']);
    expect('connectionMode' in merged).toBe(false);
    expect('onboardingCompleted' in merged).toBe(false);
  });

  it.each([
    ['missing file (undefined)', undefined],
    ['null', null],
    ['a string', 'not json'],
    ['an array', [{ apiKey: 'sk', connectionMode: 'local' }]]
  ])('yields exactly next when raw is %s', (_label, raw) => {
    const next = { apiKey: 'sk-fresh', modelName: 'gpt-5.6-luna' };

    const merged = mergePersistedSettings(raw, next);

    expect(merged).toEqual(next);
  });

  it('governs a foreign-named key colliding with an owned name by next', () => {
    // `providers` is server-owned; whatever raw holds must not leak through as a
    // "foreign" key, and next's value always wins.
    const raw = { providers: [{ id: 'sneaky' }], connectionMode: 'local' };
    const next = { providers: [{ id: 'openai' }], modelName: 'gpt-5.6-luna' };

    const merged = mergePersistedSettings(raw, next);

    expect(merged.providers).toEqual([{ id: 'openai' }]);
    expect(merged.connectionMode).toBe('local');
  });
});
