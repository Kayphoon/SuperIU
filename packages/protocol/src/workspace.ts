/**
 * Workspace targeting contracts.
 *
 * Agent sessions may operate either on the VPS gateway itself ("server") or on
 * a registered desktop client, in which case filesystem / shell RPCs are routed
 * to that device.
 */

/** Where the agent workspace physically lives. */
export type WorkspaceLocation = 'server' | 'desktop';

/** Describes the workspace root an agent session is bound to. */
export interface WorkspaceTarget {
  location: WorkspaceLocation;
  /** Absolute root path of the workspace. */
  workspaceRoot: string;
  /** Target device when {@link location} is `'desktop'`. */
  targetDeviceId?: string;
}

/** Narrowing guard: a desktop workspace always carries a target device id. */
export interface DesktopWorkspaceTarget extends WorkspaceTarget {
  location: 'desktop';
  targetDeviceId: string;
}

/** A workspace resolved to the gateway host. */
export interface ServerWorkspaceTarget extends WorkspaceTarget {
  location: 'server';
  targetDeviceId?: undefined;
}

/** Type guard for {@link DesktopWorkspaceTarget}. */
export function isDesktopWorkspaceTarget(
  target: WorkspaceTarget,
): target is DesktopWorkspaceTarget {
  return target.location === 'desktop' && typeof target.targetDeviceId === 'string';
}

/** Type guard for {@link ServerWorkspaceTarget}. */
export function isServerWorkspaceTarget(
  target: WorkspaceTarget,
): target is ServerWorkspaceTarget {
  return target.location === 'server';
}
