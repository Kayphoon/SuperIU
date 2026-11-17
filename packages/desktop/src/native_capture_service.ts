import * as fs from 'node:fs';
import * as path from 'node:path';
import { NativeCapture } from './native_capture.js';
import {
  DEFAULT_NATIVE_CAPTURE_SETTINGS,
  NativeCaptureSettingsError,
  parseNativeCaptureSettings,
  type NativeCaptureSettings,
  type NativeCaptureState
} from './native_capture_settings.js';

/** Owns machine-local settings and serializes settings changes with helper lifetime. */
export class NativeCaptureService {
  private capture: NativeCapture | null = null;
  private settings: NativeCaptureSettings = DEFAULT_NATIVE_CAPTURE_SETTINGS;
  private error: string | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    readonly binaryPath: string;
    readonly settingsPath: string;
    readonly supported: boolean;
  }) {}

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private snapshot(): NativeCaptureState {
    return {
      supported: this.options.supported,
      running: this.capture?.isRunning ?? false,
      settings: this.settings,
      ...(this.error ? { error: this.error } : {})
    };
  }

  private persist(settings: NativeCaptureSettings): void {
    fs.mkdirSync(path.dirname(this.options.settingsPath), { recursive: true });
    fs.writeFileSync(this.options.settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  }

  async start(): Promise<void> {
    await this.serialize(async () => {
      try {
        const saved = fs.existsSync(this.options.settingsPath)
          ? parseNativeCaptureSettings(JSON.parse(fs.readFileSync(this.options.settingsPath, 'utf8')))
          : undefined;
        this.settings = saved ?? DEFAULT_NATIVE_CAPTURE_SETTINGS;
        if (!this.options.supported || !this.settings.enabled) return;
        const capture = await this.launch();
        // Adopt the legacy cache choice before the first host settings file exists.
        const configuration = saved ?? await capture.getSettings();
        const applied = await capture.configure(configuration);
        const next = { enabled: true, ...applied };
        this.persist(next);
        this.settings = next;
        this.error = undefined;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        await this.capture?.stop();
        this.capture = null;
        console.warn(`[native-capture] ${this.error}`);
      }
    });
  }

  private async launch(): Promise<NativeCapture> {
    if (this.capture?.isRunning) return this.capture;
    const capture = new NativeCapture({
      binaryPath: this.options.binaryPath,
      onSettings: () => {
        // Treat a menu event as invalidation: a queued host edit may supersede it.
        void this.getState().catch((error: unknown) => {
          this.error = error instanceof Error ? error.message : String(error);
          console.warn(`[native-capture] ${this.error}`);
        });
      }
    });
    this.capture = capture;
    if (!(await capture.start())) {
      await capture.stop();
      this.capture = null;
      throw new NativeCaptureSettingsError('Capture helper is unavailable. Build or reinstall the desktop app.');
    }
    return capture;
  }

  getState(): Promise<NativeCaptureState> {
    return this.serialize(async () => {
      if (this.capture?.isRunning) {
        const configuration = await this.capture.getSettings();
        const next = { enabled: this.settings.enabled, ...configuration };
        if (JSON.stringify(next) !== JSON.stringify(this.settings)) {
          this.persist(next);
          this.settings = next;
        }
      }
      return this.snapshot();
    });
  }

  setSettings(input: unknown): Promise<NativeCaptureState> {
    const requested = parseNativeCaptureSettings(input);
    return this.serialize(async () => {
      if (!this.options.supported) {
        throw new NativeCaptureSettingsError('Native capture requires the macOS 14+ desktop app.');
      }
      const previous = this.settings;
      const wasRunning = this.capture?.isRunning ?? false;
      let applied = false;
      try {
        let next = requested;
        if (requested.enabled) {
          const capture = await this.launch();
          next = { enabled: true, ...await capture.configure(requested) };
          applied = true;
        }
        this.persist(next);
        if (!next.enabled) {
          await this.capture?.stop();
          this.capture = null;
        }
        this.settings = next;
        this.error = undefined;
        return this.snapshot();
      } catch (error) {
        if (!wasRunning) {
          await this.capture?.stop();
          this.capture = null;
        } else if (applied && this.capture?.isRunning) {
          // Also restore native state if applying succeeded but the disk write failed.
          await this.capture.configure(previous);
        }
        throw error;
      }
    });
  }

  clearHistory(): Promise<void> {
    return this.serialize(async () => {
      if (!this.capture?.isRunning) {
        throw new NativeCaptureSettingsError('Enable capture and clipboard before clearing history.');
      }
      await this.capture.clearHistory();
    });
  }

  stop(): Promise<void> {
    return this.serialize(async () => {
      await this.capture?.stop();
      this.capture = null;
    });
  }
}
