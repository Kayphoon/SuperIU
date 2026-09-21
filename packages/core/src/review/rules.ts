import * as path from 'node:path';
import type { ReviewResult, RiskLevel, ToolReviewContext } from './types.js';

/** Files whose contents are credentials or system secrets. */
const SENSITIVE_PATH_FRAGMENTS: readonly string[] = [
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/passwd',
  '/etc/sudoers',
  '/etc/master.passwd',
  '.ssh/id_rsa',
  '.ssh/id_ed25519',
  '.ssh/id_ecdsa',
  '.aws/credentials',
  '.netrc'
];

/** Targets whose recursive deletion is not recoverable by any routine means. */
const UNRECOVERABLE_TARGETS: readonly string[] = [
  '/',
  '/*',
  '~',
  '~/*',
  '$HOME',
  '$HOME/*',
  '/etc',
  '/usr',
  '/var',
  '/bin',
  '/sbin',
  '/boot',
  '/dev',
  '/opt',
  '/root',
  '/home',
  '/Users',
  '/System',
  '/Library',
  '/Applications'
];

/**
 * Read-only command shapes that are safe to approve without a model round-trip.
 * Anything carrying shell metacharacters (redirect, pipe, chain, substitution)
 * falls out of the fast path because it can mutate state.
 */
const SAFE_COMMAND_PATTERNS: readonly RegExp[] = [
  /^git\s+(?:status|diff|log|branch)\b/,
  /^ls\b/,
  /^pwd\b/,
  /^node\s+-v\b/,
  /^pnpm\s+-v\b/,
  /^npm\s+-v\b/,
  /^cat\s+/,
  /^head\s+/,
  /^tail\s+/,
  /^echo\s+/
];

/** Branch deletion/move is a mutation despite matching the `git branch` prefix. */
const GIT_BRANCH_MUTATION = /^git\s+branch\s+(?:-[dDmM]\b|--delete\b|--move\b)/;

/**
 * Every shell construct that can chain, background, group, redirect, or
 * substitute a second command behind a safe-looking first token. A `&` chain
 * (`git status && rm -rf dist`) or a bare `&` background job must fall out of
 * the fast path exactly like `;` and `|` already do; `\` is included because it
 * escapes a newline and joins two commands into one logical line. Over-rejecting
 * only costs a model round-trip, while under-rejecting auto-approves a mutation.
 */
const SHELL_METACHARACTERS = /[&|;<>`(){}$\\\n\r]/;

/** Verbs that turn a `.git` path reference into a destructive operation. */
const GIT_MUTATION_VERBS = /\b(?:rm|mv|cp|truncate|chmod|chown|sed\s+-i|shred)\b|>>?\s/;

/** Network-capable tools and destinations; combined with a credential read this is exfiltration. */
const NETWORK_EGRESS =
  /\b(?:curl|wget|nc|netcat|ncat|ssh|scp|sftp|rsync|telnet|ftp)\b|https?:\/\/|\b\d{1,3}(?:\.\d{1,3}){3}\b/;

/**
 * Hostile or unrecoverable command shapes. These are the ONLY rule-level hard
 * denies: everything else that is merely destructive escalates to a human so a
 * developer is never blocked from ordinary work (`rm -rf dist`, `git clean`, …).
 */
const HOSTILE_COMMAND_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/, reason: 'Fork bomb' },
  { pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/i, reason: 'Filesystem format command destroys a volume' },
  { pattern: /\bdd\b[^\n]*\b(?:if|of)=/i, reason: 'Raw disk read/write via dd' },
  {
    pattern: /\bchmod\s+[^\n]*\b(?:777|a\+rwx)\s+\/(?:\s|$|\*)/,
    reason: 'World-writable filesystem root'
  },
  {
    pattern: /\bchown\s+-R\b[^\n]*\s\/(?:\s|$|\*)/,
    reason: 'Recursive ownership change on the filesystem root'
  }
];

/** Script interpreters whose ad-hoc invocation runs arbitrary code. */
const SCRIPT_INTERPRETERS = /\b(?:node|bun|deno|python3?|ruby|perl|php|bash|sh|zsh|fish|tsx|ts-node)\b/;

/** Package-manager verbs that mutate the dependency tree. */
const DEPENDENCY_MUTATION =
  /\b(?:pnpm|npm|yarn|bun|pip3?|poetry|cargo|go|apt|apt-get|brew|gem)\s+(?:add|install|i|remove|rm|uninstall|update|upgrade|publish)\b/;

/** Git verbs that discard or rewrite local work. */
const GIT_DESTRUCTIVE =
  /\bgit\s+(?:clean\b|reset\s+--hard\b|checkout\s+--\s|restore\b|push\b[^\n]*--force|push\b[^\n]*\s-f\b|branch\s+-D\b|stash\s+(?:drop|clear)\b|filter-branch\b)/;

/** Privilege escalation and process termination. */
const PRIVILEGE_OR_KILL = /\b(?:sudo|doas|su)\b|\b(?:pkill|killall)\b|\bkill\s+-9\b/;

function allow(reason: string, riskLevel: RiskLevel = 'safe'): ReviewResult {
  return { decision: 'allow', riskLevel, reason, reviewedBy: 'rule' };
}

function escalate(reason: string, riskLevel: RiskLevel = 'high'): ReviewResult {
  return { decision: 'ask_user', riskLevel, reason, reviewedBy: 'rule' };
}

function deny(reason: string, riskLevel: RiskLevel = 'critical'): ReviewResult {
  return { decision: 'deny', riskLevel, reason, reviewedBy: 'rule' };
}

/** True when the argument text references a credential or system-secret file. */
export function referencesSensitivePath(text: string): boolean {
  const normalized = text.replace(/\\/g, '/');
  return SENSITIVE_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Describe why a write target is outside the ordinary workspace, or `null` when
 * it is a normal in-workspace path. Outside targets are escalations, not denials:
 * writing to `~/.config` or another checkout can be exactly what was asked for.
 */
export function matchUnsafeWriteTarget(target: string, workspaceDir: string): string | null {
  const root = path.resolve(workspaceDir);
  const resolved = path.resolve(root, target);
  const relative = path.relative(root, resolved);

  if (relative === '') {
    return `Target is the workspace root itself: ${target}`;
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return `Path resolves outside the workspace: ${target} → ${resolved}`;
  }
  if (relative === '.git' || relative.startsWith(`.git${path.sep}`)) {
    return `Target is inside .git internals: ${target}`;
  }
  return null;
}

interface RmInvocation {
  recursive: boolean;
  targets: string[];
}

function parseRm(command: string): RmInvocation | null {
  const match = /\brm\s+([^;&|\n]*)/.exec(command);
  if (!match) {
    return null;
  }

  const tokens = match[1].trim().split(/\s+/).filter(Boolean);
  const flags = tokens.filter((token) => token.startsWith('-')).join('');

  return {
    recursive: /r/i.test(flags) || /--recursive/i.test(flags),
    targets: tokens.filter((token) => !token.startsWith('-')).map((t) => t.replace(/['"]/g, ''))
  };
}

/** Credential material combined with a network destination is exfiltration. */
function matchExfiltration(command: string): string | null {
  if (referencesSensitivePath(command) && NETWORK_EGRESS.test(command)) {
    return 'Sending credential material to a network destination';
  }
  return null;
}

/** Hostile or unrecoverable operations: denied outright, no human override. */
function matchHostileCommand(command: string): string | null {
  for (const { pattern, reason } of HOSTILE_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return reason;
    }
  }

  const rm = parseRm(command);
  if (rm?.recursive) {
    for (const target of rm.targets) {
      if (UNRECOVERABLE_TARGETS.includes(target)) {
        return `Recursive delete of ${target} is not recoverable`;
      }
    }
  }

  return matchExfiltration(command);
}

/** Read-only single commands that need no model arbitration. */
function isSafeReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_METACHARACTERS.test(trimmed)) {
    return false;
  }
  if (GIT_BRANCH_MUTATION.test(trimmed) || referencesSensitivePath(trimmed)) {
    return false;
  }
  return SAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Redirects such as `echo x > /etc/hosts` write outside the workspace. */
function matchUnsafeRedirect(command: string, workspaceDir: string): string | null {
  for (const [, rawTarget] of command.matchAll(/>>?\s*([^\s;&|]+)/g)) {
    if (rawTarget.startsWith('/dev/')) {
      continue;
    }
    const reason = matchUnsafeWriteTarget(rawTarget.replace(/^['"]|['"]$/g, ''), workspaceDir);
    if (reason) {
      return `Redirect target outside the workspace: ${reason}`;
    }
  }
  return null;
}

/**
 * Mutative or sensitive operations that a human should confirm. These are not
 * blocked — they surface on the interactive Approval Card with a rationale, so
 * the developer stays in control instead of fighting a blanket denylist.
 */
function matchEscalationCommand(
  command: string,
  workspaceDir: string
): { reason: string; riskLevel: RiskLevel } | null {
  const trimmed = command.trim();

  if (referencesSensitivePath(trimmed)) {
    return { reason: 'Touches credential or system-secret material', riskLevel: 'high' };
  }

  const rm = parseRm(command);
  if (rm?.recursive && rm.targets.length > 0) {
    return { reason: `Recursive delete of ${rm.targets.join(', ')}`, riskLevel: 'high' };
  }

  if (GIT_DESTRUCTIVE.test(trimmed)) {
    return { reason: 'Git command discards or rewrites local work', riskLevel: 'medium' };
  }

  if (/(?:^|[\s'"/])\.git(?:[/\s'"]|$)/.test(trimmed) && GIT_MUTATION_VERBS.test(trimmed)) {
    return { reason: 'Modifies .git internals', riskLevel: 'high' };
  }

  const redirect = matchUnsafeRedirect(trimmed, workspaceDir);
  if (redirect) {
    return { reason: redirect, riskLevel: 'high' };
  }

  if (PRIVILEGE_OR_KILL.test(trimmed)) {
    return { reason: 'Privilege escalation or process termination', riskLevel: 'high' };
  }

  if (DEPENDENCY_MUTATION.test(trimmed)) {
    return { reason: 'Mutates the dependency tree', riskLevel: 'medium' };
  }

  // Ad-hoc interpreter invocation (`node app.js`, `sh -c ...`, `./build`) runs
  // arbitrary code. Version probes stay on the safe fast path above.
  const isVersionProbe = /^(?:node|bun|deno|python3?|ruby|perl|php)\s+(?:-v|--version)\s*$/.test(trimmed);
  if (!isVersionProbe && (SCRIPT_INTERPRETERS.test(trimmed) || /^\.\/\S/.test(trimmed))) {
    return { reason: 'Executes a script or inline program', riskLevel: 'medium' };
  }

  if (NETWORK_EGRESS.test(trimmed)) {
    return { reason: 'Performs network egress', riskLevel: 'medium' };
  }

  // A command carrying shell metacharacters is a compound line: a second command
  // may be chained, backgrounded, grouped, redirected, or substituted behind a
  // benign-looking first token. It never earns the read-only fast path above, and
  // it must not fall through to the lenient mode default either — an unclassified
  // mutation behind `&&` is exactly the shape a human must see.
  if (SHELL_METACHARACTERS.test(trimmed)) {
    return { reason: 'Command chains, backgrounds, or redirects multiple shell operations', riskLevel: 'high' };
  }

  return null;
}

/**
 * Rule fast path. Returns a verdict only when the outcome is unambiguous:
 * `allow` for known-safe reads, `deny` for hostile/unrecoverable operations,
 * and `ask_user` for mutative or sensitive work a human should confirm.
 * `null` means the call must be arbitrated by the review model (or the
 * reviewer's mode default when no model is wired).
 */
export function checkRules(ctx: ToolReviewContext): ReviewResult | null {
  const { toolCall, workspaceDir } = ctx;
  const args = toolCall.args ?? {};

  if (typeof args.command === 'string') {
    const hostile = matchHostileCommand(args.command);
    if (hostile) {
      return deny(hostile);
    }
    if (isSafeReadOnlyCommand(args.command)) {
      return allow('Read-only command on the fast-path allowlist');
    }
    const escalation = matchEscalationCommand(args.command, workspaceDir);
    if (escalation) {
      return escalate(escalation.reason, escalation.riskLevel);
    }
    return null;
  }

  if (typeof args.path !== 'string') {
    return null;
  }

  // `write_file` may carry an inline `then_run` command: it executes with the
  // same authority as `bash`, so it clears the same rule layers.
  if (typeof args.then_run === 'string' && args.then_run.trim()) {
    const hostile = matchHostileCommand(args.then_run);
    if (hostile) {
      return deny(`then_run command rejected: ${hostile}`);
    }
    const escalation = matchEscalationCommand(args.then_run, workspaceDir);
    if (escalation) {
      return escalate(`then_run command needs confirmation: ${escalation.reason}`, escalation.riskLevel);
    }
  }

  if (referencesSensitivePath(args.path)) {
    return escalate('Touches credential or system-secret material', 'high');
  }

  if (toolCall.name === 'write_file') {
    const outside = matchUnsafeWriteTarget(args.path, workspaceDir);
    if (outside) {
      return escalate(`Write target is outside the ordinary workspace: ${outside}`, 'high');
    }
    return null;
  }

  if (toolCall.name === 'read_file') {
    return allow('Reading a workspace file');
  }

  return null;
}

/** Risk hint used for the mode default and the review-model prompt. */
export function classifyFallbackRisk(ctx: ToolReviewContext): RiskLevel {
  const { toolCall } = ctx;
  const args = toolCall.args ?? {};

  if (typeof args.command === 'string') {
    if (referencesSensitivePath(args.command) || NETWORK_EGRESS.test(args.command)) {
      return 'high';
    }
    return 'medium';
  }
  if (typeof args.path === 'string' && referencesSensitivePath(args.path)) {
    return 'high';
  }
  if (toolCall.name === 'read_file') {
    return 'low';
  }
  return 'medium';
}
