/**
 * OpenSSH ControlMaster connection reuse.
 *
 * A remote connection runs several `ssh` commands back to back (probe →
 * install → workspace → start → status), and then keeps a long-lived `-N`
 * tunnel open. Without connection multiplexing every one of those pays the full
 * TCP + SSH handshake cost, and — worse — each may prompt for a key passphrase
 * or host-key confirmation. ControlMaster lets the first command authenticate
 * and then reuses that single authenticated master connection for every
 * subsequent command (and the tunnel), so the user is asked at most once and
 * the later commands return almost instantly.
 *
 * The options are passed with `-o` on the command line, which takes precedence
 * over any matching `ControlMaster`/`ControlPath`/`ControlPersist` directives
 * the user may have in `~/.ssh/config`. That keeps our reuse policy
 * deterministic regardless of the user's own ssh configuration.
 *
 * The control socket lives in {@link sshControlDir} (override with
 * `SUPERIU_SSH_CONTROL_DIR`), a private per-user directory created with `0700`
 * permissions because the socket it holds is equivalent to a live authenticated
 * session.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Resolve the directory that holds the ControlMaster sockets.
 *
 * Honours `SUPERIU_SSH_CONTROL_DIR` when set (useful for tests and sandboxed
 * environments), otherwise defaults to `~/.superiu/run`.
 */
export function sshControlDir(): string {
  const override = process.env.SUPERIU_SSH_CONTROL_DIR;
  if (override && override.trim() !== '') return override;
  return path.join(os.homedir(), '.superiu', 'run');
}

/**
 * Ensure the control directory exists and is private (`0700`), returning its
 * path. Every filesystem operation is best-effort: a failure to create or
 * chmod the directory must never break the connection, so this function never
 * throws.
 */
export function ensureSshControlDir(): string {
  const dir = sshControlDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort: ssh may still create it, or use an alternative path */
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best-effort: platform may not support POSIX modes */
  }
  return dir;
}

/**
 * The `-o` option pairs that enable ControlMaster reuse. The `%r@%h-%p`
 * placeholder yields one master socket per (user, host, port) triple, so
 * connections to different hosts never collide.
 *
 * The directory is prepared first, but the call is wrapped so a surprising
 * filesystem failure cannot prevent us from producing argv.
 */
export function sshControlArgs(): string[] {
  // Win32-OpenSSH does not implement connection multiplexing: a `ControlMaster`
  // option there can fail the connection outright rather than being ignored.
  // Skip reuse on Windows and accept the extra handshakes, which keeps the
  // remote flow working exactly as it did before.
  if (process.platform === 'win32') return [];

  let controlPath: string;
  try {
    controlPath = path.join(ensureSshControlDir(), 'ssh-%r@%h-%p');
  } catch {
    controlPath = path.join(sshControlDir(), 'ssh-%r@%h-%p');
  }
  return [
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${controlPath}`,
    '-o',
    'ControlPersist=10m',
  ];
}
