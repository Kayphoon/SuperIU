/** Machine-local preferences, independent of the connected workspace/server. */
export interface NativeShortcut {
  readonly keyCode: number;
  readonly modifiers: number;
}

export interface NativeCaptureConfiguration {
  readonly captureShortcut: NativeShortcut;
  readonly historyShortcut: NativeShortcut;
  readonly imagePersistenceEnabled: boolean;
}

export interface NativeCaptureSettings extends NativeCaptureConfiguration {
  readonly enabled: boolean;
}

export interface NativeCaptureState {
  readonly supported: boolean;
  readonly running: boolean;
  readonly settings: NativeCaptureSettings;
  readonly error?: string;
}

export const DEFAULT_NATIVE_CAPTURE_SETTINGS: NativeCaptureSettings = {
  enabled: true,
  captureShortcut: { keyCode: 19, modifiers: 768 },
  historyShortcut: { keyCode: 9, modifiers: 768 },
  imagePersistenceEnabled: false
};

export class NativeCaptureSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeCaptureSettingsError';
  }
}

function parseShortcut(value: unknown): NativeShortcut {
  if (
    typeof value !== 'object' || value === null ||
    !('keyCode' in value) || typeof value.keyCode !== 'number' ||
    !Number.isInteger(value.keyCode) || value.keyCode < 0 || value.keyCode > 127 ||
    !('modifiers' in value) || typeof value.modifiers !== 'number' ||
    !Number.isInteger(value.modifiers) || value.modifiers < 0 || value.modifiers > 6912 ||
    (value.modifiers & ~6912) !== 0 || (value.modifiers & 6400) === 0
  ) {
    throw new NativeCaptureSettingsError('Use a key with Command, Option or Control.');
  }
  return { keyCode: value.keyCode, modifiers: value.modifiers };
}

export function parseNativeCaptureConfiguration(value: unknown): NativeCaptureConfiguration {
  if (
    typeof value !== 'object' || value === null ||
    !('captureShortcut' in value) || !('historyShortcut' in value) ||
    !('imagePersistenceEnabled' in value) || typeof value.imagePersistenceEnabled !== 'boolean'
  ) {
    throw new NativeCaptureSettingsError('Invalid capture and clipboard configuration.');
  }
  const captureShortcut = parseShortcut(value.captureShortcut);
  const historyShortcut = parseShortcut(value.historyShortcut);
  if (
    captureShortcut.keyCode === historyShortcut.keyCode &&
    captureShortcut.modifiers === historyShortcut.modifiers
  ) {
    throw new NativeCaptureSettingsError('Capture and clipboard history need different shortcuts.');
  }
  return { captureShortcut, historyShortcut, imagePersistenceEnabled: value.imagePersistenceEnabled };
}

export function parseNativeCaptureSettings(value: unknown): NativeCaptureSettings {
  if (
    typeof value !== 'object' || value === null ||
    !('enabled' in value) || typeof value.enabled !== 'boolean'
  ) {
    throw new NativeCaptureSettingsError('Invalid capture service setting.');
  }
  return { enabled: value.enabled, ...parseNativeCaptureConfiguration(value) };
}
