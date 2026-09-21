/**
 * SuperIU · Notification subsystem
 * ---------------------------------------------------------------------------
 * Zero-dependency browser ESM. Installs `window.SuperIUNotifications`.
 *
 * Three independent channels, all synthesised locally — no audio or image
 * assets are ever fetched:
 *
 *   1. Desktop notifications   — Notification API, `silent: true` (we own the
 *                                sound), click focuses the window.
 *   2. Web Audio chimes        — AudioContext + convolver reverb, generated
 *                                impulse response, no sample files.
 *   3. In-app toast stack      — macOS-style top-right toasts with entrance /
 *                                exit animation, icons, actions, hover-pause.
 *
 * Every entry point is safe to call before the user has granted notification
 * permission or interacted with the page; failures degrade silently.
 */

const VERSION = '1.0.0';

const STORAGE = {
  muted: 'superiu.notifications.muted',
  desktop: 'superiu.notifications.desktop',
  asked: 'superiu.notifications.auto-requested'
};

const KIND_META = {
  info: { accent: 'var(--siu-info-fg, #7dd3fc)', label: 'Info' },
  success: { accent: 'var(--siu-accent, #2fe3cb)', label: 'Done' },
  error: { accent: 'var(--siu-danger-fg, #fb7185)', label: 'Error' },
  approval: { accent: 'var(--siu-think-fg, #a78bfa)', label: 'Approval' }
};

const DEFAULT_TIMEOUT = { info: 5000, success: 4500, approval: 9000, error: 0 };
const MAX_TOASTS = 5;

// ---------------------------------------------------------------------------
// Environment probes (all guarded — this file must never throw at import time)
// ---------------------------------------------------------------------------

const hasWindow = typeof window !== 'undefined';
const hasDocument = typeof document !== 'undefined';
const hasAudio = typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined';

/** localStorage can throw in private mode / sandboxed frames. */
function readFlag(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === '1';
  } catch {
    return fallback;
  }
}

function writeFlag(key, value) {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* storage unavailable — in-memory state still works */
  }
}

// ---------------------------------------------------------------------------
// Web Audio engine — pure synthesis, generated reverb tail
// ---------------------------------------------------------------------------

const NOTE = {
  A3: 220.0,
  C4: 261.63,
  E4: 329.63,
  A4: 440.0,
  C5: 523.25,
  E5: 659.25,
  G5: 783.99,
  A5: 880.0
};

class ChimeEngine {
  constructor() {
    this.context = null;
    this.master = null;
    this.wet = null;
    this.pending = [];
    this.installGestureUnlock();
  }

  /**
   * AudioContext starts suspended under the browser autoplay policy, so the
   * first real gesture resumes it. Chimes requested before that are queued and
   * replayed in order. Crucially we only build the context when a chime was
   * actually blocked — a user who never hears a chime never allocates audio.
   */
  installGestureUnlock() {
    if (!hasWindow) return;
    const unlock = () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
      if (!this.pending.length) return;
      const queued = this.pending;
      this.pending = [];
      this.resume().then((running) => {
        if (running) queued.forEach((schedule) => this.schedule(schedule));
        else this.pending.unshift(...queued);
      });
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock, { passive: true });
  }

  /** Lazily build the graph: source -> master -> (dry, convolver -> wet) -> out. */
  ensure() {
    if (!hasAudio || !hasWindow) return null;
    if (this.context) return this.context;
    const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      const context = new Ctor({ latencyHint: 'interactive' });
      const master = context.createGain();
      master.gain.value = 0.9;
      master.connect(context.destination);

      const convolver = context.createConvolver();
      convolver.buffer = this.buildImpulse(context, 1.7, 2.8);
      const wet = context.createGain();
      wet.gain.value = 0.22;
      convolver.connect(wet).connect(context.destination);
      master.connect(convolver);

      this.context = context;
      this.master = master;
      this.wet = wet;
      return context;
    } catch {
      return null;
    }
  }

  /** Exponentially decaying noise burst — a small, plausible room. */
  buildImpulse(context, seconds, decay) {
    const rate = context.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const buffer = context.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return buffer;
  }

  resume() {
    const context = this.context ?? this.ensure();
    if (!context) return Promise.resolve(false);
    if (context.state === 'running') return Promise.resolve(true);
    return context.resume().then(
      () => context.state === 'running',
      () => false
    );
  }

  /** Schedule one enveloped partial. */
  voice(context, { frequency, at, duration, type = 'sine', peak = 0.16, pan = 0, detune = 0, attack = 0.012, cutoff = 0 }) {
    const now = context.currentTime;
    const start = now + at;
    const osc = context.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, start);
    if (detune) osc.detune.setValueAtTime(detune, start);

    const env = context.createGain();
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(peak, start + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    const panner = context.createStereoPanner();
    panner.pan.setValueAtTime(pan, start);

    // env -> [lowpass] -> panner -> master, built once so nothing is re-wired.
    const filter = cutoff ? context.createBiquadFilter() : null;
    if (filter) {
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(cutoff, start);
      filter.Q.value = 0.4;
    }
    const chain = filter ? env.connect(filter).connect(panner) : env.connect(panner);
    chain.connect(this.master);

    osc.connect(env);
    osc.start(start);
    osc.stop(start + duration + 0.08);
    osc.onended = () => {
      osc.disconnect();
      env.disconnect();
      panner.disconnect();
      filter?.disconnect();
    };
  }

  /** Schedule a chime against a live context, swallowing audio faults. */
  schedule(schedule) {
    try {
      schedule(this.context);
    } catch {
      /* audio failures must never break the UI */
    }
  }

  /** Wrap a scheduling function with mute / context / autoplay guards. */
  play(schedule) {
    if (readFlag(STORAGE.muted, false)) return;
    const context = this.ensure();
    if (!context) return;
    if (context.state === 'running') return this.schedule(schedule);
    // Blocked by the autoplay policy: remember the intent, unlock on gesture.
    if (!this.pending.includes(schedule)) this.pending.push(schedule);
    this.resume().then((running) => {
      if (!running) return;
      const index = this.pending.indexOf(schedule);
      if (index !== -1) this.pending.splice(index, 1);
      this.schedule(schedule);
    });
  }
}

const chimes = new ChimeEngine();

/** Upbeat C5 → E5 → G5 arpeggio with a shimmer octave on top. */
function scheduleSuccess(context) {
  const notes = [
    { frequency: NOTE.C5, at: 0.0, pan: -0.28 },
    { frequency: NOTE.E5, at: 0.085, pan: 0.0 },
    { frequency: NOTE.G5, at: 0.17, pan: 0.28 }
  ];
  for (const note of notes) {
    chimes.voice(context, { ...note, duration: 0.5, peak: 0.15 });
    chimes.voice(context, {
      frequency: note.frequency * 2,
      at: note.at + 0.004,
      duration: 0.34,
      peak: 0.035,
      type: 'triangle',
      pan: note.pan
    });
  }
  chimes.voice(context, { frequency: NOTE.G5 * 2, at: 0.255, duration: 0.7, peak: 0.05, type: 'sine', pan: 0 });
}

/** Gentle two-note prompt: A4 → A5, no attack edge. */
function scheduleApproval(context) {
  chimes.voice(context, { frequency: NOTE.A4, at: 0, duration: 0.75, peak: 0.13, attack: 0.03 });
  chimes.voice(context, { frequency: NOTE.A5, at: 0.15, duration: 0.6, peak: 0.1, attack: 0.02, pan: 0.12 });
  chimes.voice(context, { frequency: NOTE.E5, at: 0.15, duration: 0.5, peak: 0.045, type: 'triangle', pan: -0.12 });
}

/** Soft A-minor triad, filtered and slowly decaying — a warning, not an alarm. */
function scheduleError(context) {
  const chord = [NOTE.A3, NOTE.C4, NOTE.E4];
  chord.forEach((frequency, index) => {
    chimes.voice(context, {
      frequency,
      at: 0,
      duration: 1.05,
      peak: 0.1,
      attack: 0.05,
      type: 'triangle',
      cutoff: 1400,
      detune: index === 1 ? -6 : index === 2 ? 6 : 0,
      pan: (index - 1) * 0.2
    });
  });
}

function playSuccessChime() {
  chimes.play(scheduleSuccess);
}

function playApprovalChime() {
  chimes.play(scheduleApproval);
}

function playErrorChime() {
  chimes.play(scheduleError);
}

// ---------------------------------------------------------------------------
// Desktop notifications
// ---------------------------------------------------------------------------

let desktopEnabled = hasWindow ? readFlag(STORAGE.desktop, true) : false;

function permissionState() {
  if (!hasWindow || typeof window.Notification !== 'function') return 'unsupported';
  return window.Notification.permission;
}

/** Resolve to `granted` | `denied` | `default` | `unsupported`. */
function requestPermission() {
  const state = permissionState();
  if (state === 'unsupported' || state !== 'default') return Promise.resolve(state);
  try {
    const result = window.Notification.requestPermission();
    // Older Safari returns undefined instead of a promise.
    if (!result || typeof result.then !== 'function') return Promise.resolve(permissionState());
    return result.then(
      (value) => value ?? permissionState(),
      () => permissionState()
    );
  } catch {
    return Promise.resolve(permissionState());
  }
}

/**
 * Fire an OS notification. Sound is always suppressed here (`silent: true`)
 * because the Web Audio chime is the single source of audio, which keeps the
 * two channels from doubling up.
 */
function showDesktopNotification(title, options = {}) {
  if (!desktopEnabled || permissionState() !== 'granted') return false;
  const { body = '', icon = '', tag, requireInteraction = false, onClick, data } = options;
  try {
    const notification = new window.Notification(String(title), {
      body,
      icon,
      tag,
      data,
      requireInteraction,
      silent: true
    });
    notification.onclick = () => {
      try {
        window.focus();
        notification.close();
      } catch {
        /* ignore */
      }
      if (typeof onClick === 'function') onClick(notification);
    };
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// In-app toast stack
// ---------------------------------------------------------------------------

const STYLE_ID = 'superiu-notifications-style';
const STACK_ID = 'superiu-toast-stack';
const TOAST_CSS = `
/* The top offset clears the app chrome so a toast never covers the window
   controls or the model selector. The 90px fallback matches --siu-chrome-h. */
.siu-stack{position:fixed;top:calc(var(--siu-chrome-h,90px) + 12px);right:14px;z-index:2147483000;display:flex;flex-direction:column;gap:10px;
  width:min(380px,calc(100vw - 28px));pointer-events:none}
.siu-toast{pointer-events:auto;display:flex;gap:11px;align-items:flex-start;box-sizing:border-box;overflow:hidden;
  padding:var(--siu-space-3,12px);border-radius:var(--siu-radius-xl,14px);
  border:1px solid var(--siu-border,rgba(255,255,255,.10));
  background:var(--siu-bg-elevated,rgba(20,23,31,.94));
  backdrop-filter:blur(24px) saturate(150%);-webkit-backdrop-filter:blur(24px) saturate(150%);
  box-shadow:var(--siu-shadow-lg,0 1px 2px rgba(0,0,0,.32),0 8px 24px rgba(0,0,0,.42),0 0 0 .5px rgba(255,255,255,.07));
  color:var(--siu-text-primary,#e9edf4);
  font:400 12px/17px var(--siu-font-sans,-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","Segoe UI",Roboto,sans-serif);
  will-change:transform,opacity}
.siu-toast[data-kind="error"]{border-color:var(--siu-danger-bd,rgba(251,113,133,.30))}
.siu-toast[data-kind="success"]{border-color:var(--siu-success-bd,rgba(52,211,153,.30))}
.siu-toast[data-kind="approval"]{border-color:var(--siu-think-bd,rgba(167,139,250,.26))}
.siu-icon{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:var(--siu-radius-md,8px);
  background:var(--siu-accent,#2fe3cb);
  color:var(--siu-text-inverse,#06070b);box-shadow:0 3px 10px -3px rgba(0,0,0,.5)}
.siu-icon svg{width:14px;height:14px}
.siu-icon img{width:16px;height:16px;border-radius:4px}
.siu-toast-main{flex:1 1 auto;min-width:0}
.siu-title{font-weight:600;font-size:12px;color:var(--siu-text-primary,#e9edf4)}
.siu-toast-body{margin-top:2px;color:var(--siu-text-secondary,#a9b1c2);word-break:break-word;white-space:pre-wrap}
.siu-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
.siu-action{appearance:none;cursor:pointer;border-radius:var(--siu-radius-md,8px);padding:4px 10px;font:600 11.5px/1.5 inherit;letter-spacing:inherit;
  border:1px solid var(--siu-border,rgba(255,255,255,.10));background:var(--siu-bg-hover,rgba(255,255,255,.055));
  color:var(--siu-text-secondary,#a9b1c2);text-decoration:none;transition:background .15s,border-color .15s,color .15s}
.siu-action:hover{background:var(--siu-bg-active,rgba(255,255,255,.085));color:var(--siu-text-primary,#e9edf4)}
.siu-action[data-primary="true"]{border-color:transparent;background:var(--siu-accent,#2fe3cb);color:var(--siu-text-inverse,#06070b)}
.siu-action[data-primary="true"]:hover{filter:brightness(1.08)}
.siu-close{flex:0 0 auto;appearance:none;cursor:pointer;width:20px;height:20px;display:flex;align-items:center;justify-content:center;
  border:0;border-radius:var(--siu-radius-xs,4px);background:transparent;color:var(--siu-text-muted,#7e8798);opacity:0;
  transition:opacity .15s,background .15s,color .15s}
.siu-toast:hover .siu-close,.siu-close:focus-visible{opacity:1}
.siu-close:hover{background:var(--siu-bg-hover,rgba(255,255,255,.055));color:var(--siu-text-primary,#e9edf4)}
.siu-close svg{width:10px;height:10px}
@media (prefers-reduced-motion:reduce){
  .siu-toast{transition:none!important}
  .siu-toast,.siu-toast *{animation:none!important;transform:none!important}
}
`;

function ensureStyles() {
  if (!hasDocument || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = TOAST_CSS;
  (document.head ?? document.documentElement).appendChild(style);
}

function ensureStack() {
  if (!hasDocument) return null;
  ensureStyles();
  const existing = document.getElementById(STACK_ID);
  if (existing) return existing;
  const stack = document.createElement('div');
  stack.id = STACK_ID;
  stack.className = 'siu-stack';
  stack.setAttribute('role', 'region');
  stack.setAttribute('aria-label', 'Notifications');
  (document.body ?? document.documentElement).appendChild(stack);
  return stack;
}

const ICONS = {
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 11v6"/><circle cx="12" cy="7.4" r="1.1" fill="currentColor" stroke="none"/></svg>',
  success:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.6 4.4 4.4L19 7.4"/></svg>',
  error:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 7.5v6.2"/><circle cx="12" cy="17.2" r="1.1" fill="currentColor" stroke="none"/></svg>',
  approval:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.2"/><path d="M12 8.6v4.6l3 1.8"/></svg>'
};

function looksLikeImage(value) {
  return typeof value === 'string' && /^(https?:|data:|blob:|\/)/.test(value);
}

const toasts = new Map();
let toastSeq = 0;

function nextToastId() {
  toastSeq += 1;
  return `siu-toast-${toastSeq}`;
}

/** Drop a record and its node without animating (reuse, overflow, clearAll). */
function evict(id) {
  const record = toasts.get(id);
  if (!record) return;
  record.closing = true;
  window.clearTimeout(record.timer);
  record.node.remove();
  toasts.delete(id);
}

function buildToast(message, options) {
  const kind = KIND_META[options.kind] ? options.kind : 'info';
  const meta = KIND_META[kind];
  const node = document.createElement('div');
  node.className = 'siu-toast';
  node.dataset.kind = kind;
  node.dataset.id = options.id;
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  node.style.setProperty('--siu-accent', meta.accent);

  const icon = document.createElement('div');
  icon.className = 'siu-icon';
  if (looksLikeImage(options.icon)) {
    const img = document.createElement('img');
    img.src = options.icon;
    img.alt = '';
    icon.appendChild(img);
  } else {
    icon.innerHTML = ICONS[KIND_META[options.icon] ? options.icon : kind];
  }
  node.appendChild(icon);

  const main = document.createElement('div');
  main.className = 'siu-toast-main';
  if (options.title) {
    const title = document.createElement('div');
    title.className = 'siu-title';
    title.textContent = options.title;
    main.appendChild(title);
  }
  if (message) {
    const body = document.createElement('div');
    body.className = 'siu-toast-body';
    body.textContent = message;
    main.appendChild(body);
  }

  const actions = Array.isArray(options.actions) ? options.actions : [];
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'siu-actions';
    for (const action of actions) {
      if (!action || !action.label) continue;
      const button = document.createElement(action.href ? 'a' : 'button');
      button.className = 'siu-action';
      button.textContent = action.label;
      if (action.href) {
        button.href = action.href;
        button.target = '_blank';
        button.rel = 'noreferrer';
      } else {
        button.type = 'button';
      }
      if (action.primary) button.dataset.primary = 'true';
      button.addEventListener('click', () => {
        try {
          if (typeof action.onClick === 'function') action.onClick();
        } finally {
          dismiss(options.id);
        }
      });
      row.appendChild(button);
    }
    main.appendChild(row);
  }
  node.appendChild(main);

  const close = document.createElement('button');
  close.className = 'siu-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.innerHTML = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg>';
  close.addEventListener('click', () => dismiss(options.id));
  node.appendChild(close);

  if (typeof options.onClick === 'function') {
    node.addEventListener('click', (event) => {
      if (event.target.closest('.siu-action, .siu-close')) return;
      options.onClick(event);
    });
    node.style.cursor = 'pointer';
  }

  return node;
}

function enter(node) {
  if (typeof node.animate !== 'function') return;
  node.animate(
    [
      { transform: 'translateX(112%) scale(.96)', opacity: 0 },
      { transform: 'none', opacity: 1 }
    ],
    // Web Animations options do not resolve CSS custom properties, so the
    // `--siu-ease-out` / `--siu-dur-*` values are inlined here.
    { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' }
  );
}

function leave(node) {
  return new Promise((resolve) => {
    if (typeof node.animate !== 'function') return resolve();
    const height = node.offsetHeight;
    const slide = node.animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: 'translateX(112%) scale(.96)', opacity: 0 }
      ],
      // Exits are always faster than entries.
      { duration: 120, easing: 'ease-in', fill: 'forwards' }
    );
    slide.finished.then(
      () => {
        const collapse = node.animate([{ height: `${height}px`, marginBottom: '0px' }, { height: '0px', marginBottom: '-10px' }], {
          duration: 150,
          easing: 'ease-in',
          fill: 'forwards'
        });
        collapse.finished.then(() => resolve(), () => resolve());
      },
      () => resolve()
    );
  });
}

/**
 * Push a toast. Returns the notification id, or `null` when no DOM is present.
 *
 * options: { title, kind, icon, timeout, actions, onClick, id }
 * `timeout: 0` keeps the toast until it is dismissed. Hovering pauses the timer.
 */
function toast(message, options = {}) {
  if (!hasDocument) return null;
  const stack = ensureStack();
  if (!stack) return null;

  const id = options.id ?? nextToastId();
  evict(id);

  const kind = KIND_META[options.kind] ? options.kind : 'info';
  const timeout = Number.isFinite(options.timeout) ? options.timeout : DEFAULT_TIMEOUT[kind];
  const node = buildToast(message === undefined || message === null ? '' : String(message), { ...options, id, kind });
  const record = { id, node, timer: 0, remaining: timeout, startedAt: 0, closing: false };
  toasts.set(id, record);

  stack.insertBefore(node, stack.firstChild);
  enter(node);

  // Evict the oldest *dismissed-less* toast once the stack is full.
  const live = [...toasts.values()].filter((entry) => !entry.closing);
  for (let i = 0; i < live.length - MAX_TOASTS; i += 1) dismiss(live[i].id);

  if (timeout > 0) {
    const start = () => {
      record.startedAt = Date.now();
      record.timer = window.setTimeout(() => dismiss(id), record.remaining);
    };
    start();
    node.addEventListener('mouseenter', () => {
      window.clearTimeout(record.timer);
      record.remaining = Math.max(600, record.remaining - (Date.now() - record.startedAt));
    });
    node.addEventListener('mouseleave', () => {
      if (!record.closing) start();
    });
  }

  return id;
}

function dismiss(id) {
  const record = toasts.get(id);
  if (!record || record.closing) return;
  record.closing = true;
  window.clearTimeout(record.timer);
  // Keep the record registered until the exit animation finishes so concurrent
  // pushes still count this node against MAX_TOASTS.
  leave(record.node).then(
    () => {
      record.node.remove();
      if (toasts.get(id) === record) toasts.delete(id);
    },
    () => {
      record.node.remove();
      if (toasts.get(id) === record) toasts.delete(id);
    }
  );
}

function clearAll() {
  for (const id of [...toasts.keys()]) {
    const record = toasts.get(id);
    toasts.delete(id);
    record.closing = true;
    window.clearTimeout(record.timer);
    record.node.remove();
  }
}

// ---------------------------------------------------------------------------
// Public channel wrappers
// ---------------------------------------------------------------------------

const BASE_ICON =
  'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%20100%20100%22%3E%3Crect%20width=%22100%22%20height=%22100%22%20rx=%2224%22%20fill=%22%230a0c12%22/%3E%3Cpath%20d=%22M54%2014%2026%2056h22l-6%2030%2034-46H52l2-26Z%22%20fill=%22%232fe3cb%22/%3E%3C/svg%3E';

/** Shared plumbing: chime + desktop + toast, each independently suppressible. */
function emit(channel, message, options = {}) {
  const kind = channel;
  const opts = {
    ...options,
    kind,
    title: options.title ?? KIND_META[kind].label,
    icon: options.icon ?? kind,
    desktop: options.desktop !== false,
    sound: options.sound !== false
  };

  if (opts.sound) {
    if (kind === 'success') playSuccessChime();
    else if (kind === 'approval') playApprovalChime();
    else if (kind === 'error') playErrorChime();
  }
  if (opts.desktop) {
    showDesktopNotification(opts.title, {
      body: message ?? '',
      icon: opts.desktopIcon ?? BASE_ICON,
      tag: opts.tag,
      data: opts.data,
      requireInteraction: opts.requireInteraction,
      onClick: opts.onDesktopClick ?? opts.onClick
    });
  }
  return toast(message, opts);
}

function notifyTaskComplete(title, body, options) {
  if (title && typeof title === 'object') {
    options = title;
    title = options.title;
    body = options.body;
  }
  return emit('success', body ?? '', { title: title ?? 'Task complete', ...options });
}

function notifyApprovalRequired(title, body, options) {
  if (title && typeof title === 'object') {
    options = title;
    title = options.title;
    body = options.body;
  }
  const opts = { title: title ?? 'Approval required', ...options };
  // The toast id is minted inside `toast()`, so handlers read it through a ref.
  const ref = { id: opts.id };
  const announce = () => {
    if (!hasWindow) return;
    window.dispatchEvent(new CustomEvent('superiu:approval-click', { detail: { id: ref.id, data: opts.data } }));
  };
  if (!opts.actions) {
    opts.actions = [{ label: 'View Approval', primary: true, onClick: announce }];
  }
  if (!opts.onClick) opts.onClick = announce;
  const id = emit('approval', body ?? 'The agent is waiting for your decision.', opts);
  ref.id = id;
  return id;
}

function notifyError(title, body, options) {
  if (title && typeof title === 'object') {
    options = title;
    title = options.title;
    body = options.body;
  }
  return emit('error', body ?? '', { title: title ?? 'Something went wrong', ...options });
}

// ---------------------------------------------------------------------------
// Settings toggles
// ---------------------------------------------------------------------------

function setMuted(muted) {
  writeFlag(STORAGE.muted, Boolean(muted));
}

function isMuted() {
  return readFlag(STORAGE.muted, false);
}

function setDesktopEnabled(enabled) {
  desktopEnabled = Boolean(enabled);
  writeFlag(STORAGE.desktop, desktopEnabled);
}

function isDesktopEnabled() {
  return desktopEnabled;
}

/**
 * Ask for permission on the first user interaction, once per browser, but only
 * when the user has not switched desktop notifications off.
 */
if (hasWindow) {
  const auto = () => {
    window.removeEventListener('pointerdown', auto);
    window.removeEventListener('keydown', auto);
    if (!desktopEnabled || readFlag(STORAGE.asked, false) || permissionState() !== 'default') return;
    writeFlag(STORAGE.asked, true);
    void requestPermission();
  };
  window.addEventListener('pointerdown', auto, { passive: true });
  window.addEventListener('keydown', auto);
}

const SuperIUNotifications = {
  version: VERSION,
  requestPermission,
  permissionState,
  showDesktopNotification,
  notifyTaskComplete,
  notifyApprovalRequired,
  notifyError,
  playSuccessChime,
  playApprovalChime,
  playErrorChime,
  toast,
  dismiss,
  clearAll,
  setMuted,
  isMuted,
  setDesktopEnabled,
  isDesktopEnabled,
  kindMeta: KIND_META
};

if (hasWindow) window.SuperIUNotifications = SuperIUNotifications;

export {
  SuperIUNotifications,
  requestPermission,
  permissionState,
  showDesktopNotification,
  notifyTaskComplete,
  notifyApprovalRequired,
  notifyError,
  playSuccessChime,
  playApprovalChime,
  playErrorChime,
  toast,
  dismiss,
  clearAll,
  setMuted,
  isMuted,
  setDesktopEnabled,
  isDesktopEnabled
};

export default SuperIUNotifications;
