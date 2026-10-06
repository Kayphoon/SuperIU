/**
 * SSH-based one-click remote VPS provisioning + tunneling.
 *
 * Barrels the four modules that make up the remote-connection flow:
 *
 *   - {@link ./ssh_config}  — zero-dependency `~/.ssh/config` parsing
 *   - {@link ./tunnel}      — `ssh -L` local port-forward management
 *   - {@link ./bootstrap}   — remote probe / install / start over ssh
 *   - {@link ./manager}     — the orchestrator tying them together
 */

export {
  parseSshConfig,
  readSshConfig,
  matchHostPattern,
  expandHome,
  resolveEntries,
  SshConfigParseError,
} from './ssh_config.js';
export type { SshHostEntry } from './ssh_config.js';

export {
  SshTunnelManager,
  isPortFree,
  pickFreePort,
} from './tunnel.js';
export type {
  SshTunnelState,
  SshTunnelOpenOptions,
  SshTunnelOpenResult,
  SshTunnelManagerOptions,
} from './tunnel.js';

export {
  RemoteBootstrapper,
  shellQuote,
  normalizeArch,
  defaultRemoteRunner,
  REMOTE_BIN_PATH,
  REMOTE_BIN_DIR,
  REMOTE_BIN_NAME,
} from './bootstrap.js';
export type {
  RemoteRunner,
  RemoteRunResult,
  RemoteProbeResult,
  RemoteInstallOptions,
  RemoteInstallResult,
  RemoteStartOptions,
  RemoteDaemonState,
} from './bootstrap.js';

export {
  RemoteConnectionManager,
  RemoteConnectionError,
} from './manager.js';
export type {
  RemoteConnectOptions,
  RemoteConnectResult,
  RemoteStep,
  RemoteStepId,
  RemoteStepStatus,
  RemoteConnectionManagerOptions,
} from './manager.js';

export {
  decideNavigationFailure,
  decideRenderProcessGone,
  normalizeNavUrl,
  NAV_RETRY_BASE_DELAY_MS,
  NAV_RETRY_MAX_DELAY_MS,
  NAV_RETRY_DEADLINE_MS,
  MAX_RENDERER_REVIVALS,
} from './navigation.js';
export type { NavigationDecision, NavigationFailure } from './navigation.js';
