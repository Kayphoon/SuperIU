/**
 * Tests for the zero-dependency `~/.ssh/config` parser.
 *
 * Covers host alias parsing, wildcard `Host *` defaults, first-match overrides,
 * multiple aliases per block, quoting/comments, and identity-file expansion, plus
 * the async {@link readSshConfig} file/include reader.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SshConfigParseError,
  expandHome,
  matchHostPattern,
  parseSshConfig,
  readSshConfig
} from '../src/remote/ssh_config.js';

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const home = os.homedir();

// ---------------------------------------------------------------------------
// parseSshConfig — aliases & options
// ---------------------------------------------------------------------------

describe('parseSshConfig host aliases', () => {
  it('parses a single host block', () => {
    const entries = parseSshConfig(`
Host myserver
  HostName example.com
  User alice
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
    `);

    expect(entries).toEqual([
      {
        alias: 'myserver',
        hostName: 'example.com',
        user: 'alice',
        port: 2222,
        identityFile: path.join(home, '.ssh', 'id_ed25519')
      }
    ]);
  });

  it('defaults hostName to the alias when HostName is absent', () => {
    const entries = parseSshConfig('Host bare\n  User bob\n');
    expect(entries).toHaveLength(1);
    expect(entries[0].hostName).toBe('bare');
    expect(entries[0].user).toBe('bob');
  });

  it('defaults port to 22 when unset', () => {
    const entries = parseSshConfig('Host a\n  HostName a.example\n');
    expect(entries[0].port).toBe(22);
  });

  it('leaves user and identityFile undefined when unset', () => {
    const entries = parseSshConfig('Host a\n  HostName a.example\n');
    expect(entries[0].user).toBeUndefined();
    expect(entries[0].identityFile).toBeUndefined();
  });

  it('parses multiple aliases on one Host line', () => {
    const entries = parseSshConfig(`
Host alpha beta gamma
  HostName shared.example.com
    `);
    expect(entries.map((e) => e.alias)).toEqual(['alpha', 'beta', 'gamma']);
    expect(entries.every((e) => e.hostName === 'shared.example.com')).toBe(true);
  });

  it('parses multiple host blocks', () => {
    const entries = parseSshConfig(`
Host one
  HostName one.example
Host two
  HostName two.example
  Port 2200
    `);
    expect(entries.map((e) => e.alias)).toEqual(['one', 'two']);
    expect(entries[1].port).toBe(2200);
  });

  it('treats keywords case-insensitively', () => {
    const entries = parseSshConfig(`
HOST Mixed
  hostname lower.example
  USER Carol
  pOrT 2022
    `);
    expect(entries[0]).toMatchObject({
      alias: 'Mixed',
      hostName: 'lower.example',
      user: 'Carol',
      port: 2022
    });
  });

  it('ignores unknown options', () => {
    const entries = parseSshConfig(`
Host a
  HostName a.example
  ForwardAgent yes
  ServerAliveInterval 60
    `);
    expect(entries[0]).toMatchObject({ alias: 'a', hostName: 'a.example' });
  });

  it('honours quoted values containing spaces', () => {
    const entries = parseSshConfig('Host a\n  HostName "my host.example"\n');
    expect(entries[0].hostName).toBe('my host.example');
  });

  it('strips trailing comments and ignores blank lines', () => {
    const entries = parseSshConfig(`
# a leading comment

Host a
  HostName a.example # inline comment

# trailing comment
    `);
    expect(entries).toEqual([{ alias: 'a', hostName: 'a.example', user: undefined, port: 22, identityFile: undefined }]);
  });

  it('keeps the first assignment within a block', () => {
    const entries = parseSshConfig(`
Host a
  HostName first.example
  HostName second.example
    `);
    expect(entries[0].hostName).toBe('first.example');
  });

  it('throws on a Host directive without a pattern', () => {
    expect(() => parseSshConfig('Host\n  User bob\n')).toThrow(SshConfigParseError);
  });

  it('returns an empty list for empty input', () => {
    expect(parseSshConfig('')).toEqual([]);
    expect(parseSshConfig('\n\n# only comments\n')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseSshConfig — wildcards & defaults
// ---------------------------------------------------------------------------

describe('parseSshConfig wildcard defaults', () => {
  it('applies `Host *` defaults to every concrete alias', () => {
    const entries = parseSshConfig(`
Host *
  User defaultuser
  Port 2222

Host a
  HostName a.example
Host b
  HostName b.example
    `);

    expect(entries.map((e) => e.alias)).toEqual(['a', 'b']);
    expect(entries[0].user).toBe('defaultuser');
    expect(entries[0].port).toBe(2222);
    expect(entries[1].user).toBe('defaultuser');
    expect(entries[1].port).toBe(2222);
  });

  it('lets a specific block override a wildcard default', () => {
    const entries = parseSshConfig(`
Host *
  User defaultuser
  Port 2222

Host a
  User alice
  Port 2200
    `);
    expect(entries[0]).toMatchObject({ alias: 'a', user: 'alice', port: 2200 });
  });

  it('applies wildcard defaults only for options the specific block left unset', () => {
    const entries = parseSshConfig(`
Host *
  User defaultuser
  Port 2222
  IdentityFile ~/.ssh/id_default

Host a
  User alice
    `);
    expect(entries[0]).toMatchObject({
      alias: 'a',
      user: 'alice',
      port: 2222,
      identityFile: path.join(home, '.ssh', 'id_default')
    });
  });

  it('supports wildcard patterns that are not a bare `*`', () => {
    const entries = parseSshConfig(`
Host *.example.com
  User domainuser
Host a.example.com
Host b.example.com
    `);
    // The `*.example.com` block is a pure wildcard, so it is a default; but the
    // two concrete aliases it would match are not themselves declared as aliases.
    expect(entries.map((e) => e.alias)).toEqual(['a.example.com', 'b.example.com']);
    expect(entries.every((e) => e.user === 'domainuser')).toBe(true);
  });

  it('lets a concrete block match a wildcard alias pattern with first-match-wins', () => {
    const entries = parseSshConfig(`
Host prod-*
  User produser
Host prod-web
  User websuser
    `);
    // `prod-*` is a wildcard block (defaults), `prod-web` is concrete and wins.
    expect(entries.map((e) => e.alias)).toEqual(['prod-web']);
    expect(entries[0].user).toBe('websuser');
  });

  it('handles wildcard defaults declared before or after concrete hosts', () => {
    const after = parseSshConfig(`
Host a
  HostName a.example
Host *
  User lateuser
    `);
    expect(after[0].user).toBe('lateuser');
  });

  it('ignores a non-matching wildcard default', () => {
    const entries = parseSshConfig(`
Host db-*
  User dbuser
Host web
  HostName web.example
    `);
    expect(entries[0].alias).toBe('web');
    expect(entries[0].user).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// matchHostPattern / expandHome
// ---------------------------------------------------------------------------

describe('matchHostPattern', () => {
  it('matches an exact alias', () => {
    expect(matchHostPattern('server', 'server')).toBe(true);
    expect(matchHostPattern('server', 'server2')).toBe(false);
  });

  it('treats `*` as a match-all', () => {
    expect(matchHostPattern('*', 'anything')).toBe(true);
  });

  it('supports `*` in the middle and `?`', () => {
    expect(matchHostPattern('web-*', 'web-1')).toBe(true);
    expect(matchHostPattern('web-*', 'db-1')).toBe(false);
    expect(matchHostPattern('h?st', 'host')).toBe(true);
    expect(matchHostPattern('h?st', 'hoost')).toBe(false);
  });

  it('anchors the whole value', () => {
    expect(matchHostPattern('web', 'web.example.com')).toBe(false);
  });

  it('escapes regex metacharacters in the pattern', () => {
    expect(matchHostPattern('a.b', 'a.b')).toBe(true);
    expect(matchHostPattern('a.b', 'axb')).toBe(false);
    expect(matchHostPattern('a+b', 'a+b')).toBe(true);
  });
});

describe('expandHome', () => {
  it('expands a bare tilde', () => {
    expect(expandHome('~')).toBe(home);
  });

  it('expands a leading `~/`', () => {
    expect(expandHome('~/.ssh/id_rsa')).toBe(path.join(home, '.ssh', 'id_rsa'));
  });

  it('leaves other paths untouched', () => {
    expect(expandHome('/etc/ssh/key')).toBe('/etc/ssh/key');
    expect(expandHome('relative/key')).toBe('relative/key');
  });
});

// ---------------------------------------------------------------------------
// readSshConfig
// ---------------------------------------------------------------------------

describe('readSshConfig', () => {
  it('reads and resolves a config file from disk', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'config');
    await fs.writeFile(
      file,
      [
        'Host myserver',
        '  HostName example.com',
        '  User alice',
        '  Port 2222',
        '  IdentityFile ~/.ssh/id_ed25519'
      ].join('\n'),
      'utf8'
    );

    await expect(readSshConfig(file)).resolves.toEqual([
      {
        alias: 'myserver',
        hostName: 'example.com',
        user: 'alice',
        port: 2222,
        identityFile: path.join(home, '.ssh', 'id_ed25519')
      }
    ]);
  });

  it('returns an empty list for a missing file instead of throwing', async () => {
    const dir = await makeTmpDir();
    await expect(readSshConfig(path.join(dir, 'does-not-exist'))).resolves.toEqual([]);
  });

  it('degrades to an empty list on malformed content', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'config');
    await fs.writeFile(file, 'Host\n  User bob\n', 'utf8'); // `Host` without pattern
    await expect(readSshConfig(file)).resolves.toEqual([]);
  });

  it('expands relative `Include` paths against the config directory', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(
      path.join(dir, 'extra.conf'),
      'Host included\n  HostName included.example\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(dir, 'config'),
      ['Host main', '  HostName main.example', 'Include extra.conf'].join('\n'),
      'utf8'
    );

    const entries = await readSshConfig(path.join(dir, 'config'));
    expect(entries.map((e) => e.alias)).toEqual(['main', 'included']);
    expect(entries[1].hostName).toBe('included.example');
  });

  it('applies `Host *` defaults across included files', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, 'defaults.conf'), 'Host *\n  User shared\n', 'utf8');
    await fs.writeFile(
      path.join(dir, 'config'),
      ['Include defaults.conf', 'Host main', '  HostName main.example'].join('\n'),
      'utf8'
    );

    const entries = await readSshConfig(path.join(dir, 'config'));
    expect(entries[0]).toMatchObject({ alias: 'main', user: 'shared' });
  });

  it('terminates on an include cycle', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(
      path.join(dir, 'a.conf'),
      ['Include b.conf', 'Host from-a', '  HostName a.example'].join('\n'),
      'utf8'
    );
    await fs.writeFile(
      path.join(dir, 'b.conf'),
      ['Include a.conf', 'Host from-b', '  HostName b.example'].join('\n'),
      'utf8'
    );

    const entries = await readSshConfig(path.join(dir, 'a.conf'));
    expect(entries.map((e) => e.alias).sort()).toEqual(['from-a', 'from-b']);
  });

  it('ignores an include that does not exist', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(
      path.join(dir, 'config'),
      ['Include missing.conf', 'Host main', '  HostName main.example'].join('\n'),
      'utf8'
    );
    await expect(readSshConfig(path.join(dir, 'config'))).resolves.toHaveLength(1);
  });
});
