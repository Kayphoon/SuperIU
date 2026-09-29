/**
 * `@agent/desktop` programmatic surface.
 *
 * The Electron entry point is `main.ts` (declared as `"main"` in package.json),
 * so this module exists for embedders and tests that want the gateway transport
 * pieces WITHOUT pulling in an Electron runtime. Both exports are deliberately
 * Electron-free:
 *
 *   - {@link GatewayClient} imports Electron's `dialog` lazily (and never at
 *     module scope), so requiring it outside the main process is safe.
 *   - {@link WorkspaceSandboxWorker} depends only on `node:fs` /
 *     `node:child_process`.
 *
 * The `./remote` barrel adds SSH-based VPS provisioning and tunneling; it is
 * likewise Electron-free.
 */

export { GatewayClient } from './gateway_client.js';
export type {
  GatewayClientOptions,
  GatewayClientState
} from './gateway_client.js';

export { WorkspaceSandboxWorker, isDangerousCommand, DEFAULT_BASH_TIMEOUT_MS } from './sandbox/worker.js';
export type { ApprovalHandler } from './sandbox/worker.js';

// ---------------------------------------------------------------------------
// SSH-based remote VPS provisioning + tunneling
// ---------------------------------------------------------------------------

export {
  parseSshConfig,
  readSshConfig,
  matchHostPattern,
  expandHome,
  SshConfigParseError,
} from './remote/ssh_config.js';
export type { SshHostEntry } from './remote/ssh_config.js';

export { SshTunnelManager, isPortFree, pickFreePort } from './remote/tunnel.js';
export type {
  SshTunnelState,
  SshTunnelOpenOptions,
  SshTunnelOpenResult,
  SshTunnelManagerOptions,
} from './remote/tunnel.js';

export {
  RemoteBootstrapper,
  shellQuote,
  normalizeArch,
  defaultRemoteRunner,
  REMOTE_BIN_PATH,
  REMOTE_BIN_DIR,
  REMOTE_BIN_NAME,
} from './remote/bootstrap.js';
export type {
  RemoteRunner,
  RemoteRunResult,
  RemoteProbeResult,
  RemoteInstallOptions,
  RemoteInstallResult,
  RemoteStartOptions,
  RemoteDaemonState,
} from './remote/bootstrap.js';

export { RemoteConnectionManager, RemoteConnectionError } from './remote/manager.js';
export type {
  RemoteConnectOptions,
  RemoteConnectResult,
  RemoteStep,
  RemoteStepId,
  RemoteStepStatus,
  RemoteConnectionManagerOptions,
} from './remote/manager.js';
