import * as path from 'node:path';
import type { ToolCallItem } from '../context/types.js';
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
 * Benign shell redirects that merely discard stdout or stderr (e.g. `2>/dev/null`, `>/dev/null`, `2>&1`).
 * Stripping these allows inspection commands to be recognized as safe read-only operations
 * rather than falsely escalating as complex compound pipelines.
 */
const BENIGN_DISCARD_REDIRECT = /\s*(?:2>\s*\/dev\/null|>\s*\/dev\/null|2>&1|1>&2)\s*/g;

/** Strip benign discard redirects for syntax analysis. */
export function stripBenignRedirects(command: string): string {
  return command.replace(BENIGN_DISCARD_REDIRECT, ' ').trim();
}

/**
 * Read-only command shapes that are safe to approve without a model round-trip.
 * Anything carrying shell metacharacters (redirect, chain, substitution)
 * falls out of the fast path because it can mutate state.
 */
const SAFE_COMMAND_PATTERNS: readonly RegExp[] = [
  /^git\s+(?:status|diff|log|branch|show|rev-parse|describe)\b/,
  /^ls\b/,
  /^pwd\b/,
  /^du\b/,
  /^df\b/,
  /^which\b/,
  /^whoami\b/,
  /^uname\b/,
  /^date\b/,
  /^uptime\b/,
  /^ps\b/,
  /^free\b/,
  /^stat\b/,
  /^file\b/,
  /^find\b/,
  /^(?:node|pnpm|npm|bun|deno|python3?|ruby|perl|php|git)\s+(?:-v|--version)\b/,
  /^(?:cat|head|tail|sort|uniq|wc|grep|egrep|fgrep|rg|cut|tr|column)\b/,
  /^echo\b/,
  /^printf\b/
];

/** Branch deletion/move is a mutation despite matching the `git branch` prefix. */
const GIT_BRANCH_MUTATION = /^git\s+branch\s+(?:-[dDmM]\b|--delete\b|--move\b)/;

/** Mutating flags that turn find into an execution or deletion tool. */
const FIND_MUTATING_FLAGS = /\s-(?:delete|exec|execdir|ok|okdir|fprint|fls)\b/;

/** Mutating flags that turn sort into a file write tool. */
const SORT_MUTATING_FLAGS = /\s(?:-o|--output)\b/;

/**
 * Metacharacters that chain commands, run in background, perform command substitution,
 * or redirect I/O to/from files. Pipelines (single `|`) are handled separately by
 * evaluating each pipeline stage independently.
 */
const DANGEROUS_SHELL_METACHARACTERS = /[&;<>`(){}$\\\n\r]|\|\|/;

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

const INTERPRETER_NAMES = new Set([
  'node',
  'bun',
  'deno',
  'python',
  'python3',
  'ruby',
  'perl',
  'php',
  'bash',
  'sh',
  'zsh',
  'fish',
  'tsx',
  'ts-node'
]);

/**
 * Checks whether the command line invokes an ad-hoc script interpreter (e.g. `python3 script.py`, `node app.js`, `sh -c ...`, `./build.sh`).
 * Inspects command token positions rather than raw substrings, avoiding false positives on command options like `du -sh` or `git status --short`.
 */
export function invokesScriptInterpreter(command: string): boolean {
  const clean = stripBenignRedirects(command);
  // Split along shell pipelines or command chains
  const subcmds = clean.split(/[;&|]+/);
  for (const rawSub of subcmds) {
    const sub = rawSub.trim();
    if (!sub) continue;

    // Tokenize words, preserving quotes
    const tokens = sub.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    let cmdToken: string | null = null;
    let isVersionProbe = false;

    for (let i = 0; i < tokens.length; i++) {
      const raw = tokens[i];
      const unquoted = raw.replace(/^['"]|['"]$/g, '');
      // Skip environment variable assignments like FOO=bar
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(unquoted)) {
        continue;
      }
      // Skip command wrappers like sudo, env, nohup, time, exec
      if (/^(?:sudo|env|nohup|time|exec)$/.test(unquoted)) {
        continue;
      }
      cmdToken = unquoted;
      const nextToken = tokens[i + 1]?.replace(/^['"]|['"]$/g, '');
      if (nextToken === '-v' || nextToken === '--version' || nextToken === '-V') {
        isVersionProbe = true;
      }
      break;
    }

    if (!cmdToken || isVersionProbe) {
      continue;
    }

    // Direct script executable path like `./script.sh` or `../run`
    if (/^\.\.?\/\S+/.test(cmdToken)) {
      return true;
    }

    const baseName = cmdToken.split('/').pop() ?? '';
    if (INTERPRETER_NAMES.has(baseName)) {
      return true;
    }
  }

  return false;
}

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

/** Checks whether a single pipeline stage is a safe read-only operation. */
function isSafeReadOnlyStage(stage: string): boolean {
  const trimmed = stage.trim();
  if (!trimmed) return false;
  if (GIT_BRANCH_MUTATION.test(trimmed) || referencesSensitivePath(trimmed)) {
    return false;
  }
  if (/^find\b/.test(trimmed) && FIND_MUTATING_FLAGS.test(trimmed)) {
    return false;
  }
  if (/^sort\b/.test(trimmed) && SORT_MUTATING_FLAGS.test(trimmed)) {
    return false;
  }
  return SAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Read-only commands that need no model arbitration.
 * Supports single commands and pipelines (e.g. `du -h -d 1 / | sort -hr | head -n 15`)
 * where every stage is a known-safe read-only inspection or filter utility.
 */
export function isSafeReadOnlyCommand(command: string): boolean {
  const stripped = stripBenignRedirects(command);
  if (!stripped || DANGEROUS_SHELL_METACHARACTERS.test(stripped)) {
    return false;
  }
  const stages = stripped.split('|');
  if (stages.length === 0) {
    return false;
  }
  return stages.every((stage) => isSafeReadOnlyStage(stage));
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

  if (/^find\b/.test(trimmed) && FIND_MUTATING_FLAGS.test(trimmed)) {
    return { reason: 'Find command executes external actions or deletes files', riskLevel: 'high' };
  }

  if (/^sort\b/.test(trimmed) && SORT_MUTATING_FLAGS.test(trimmed)) {
    return { reason: 'Sort command writes output directly to a file', riskLevel: 'medium' };
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

  if (invokesScriptInterpreter(trimmed)) {
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
  const nonRedirect = stripBenignRedirects(trimmed);
  if (SHELL_METACHARACTERS.test(nonRedirect)) {
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

const DESTRUCTIVE_BASH_TOOLS = new Set([
  'rm',
  'shred',
  'wipe',
  'dd',
  'mkfs',
  'fdisk',
  'parted'
]);

/**
 * Derives a human-readable and predictable permission pattern for a tool call.
 * For benign development commands (test, build, git diff, curl, etc.), uses command/subcommand prefix matching (e.g. `pnpm test *`).
 * For destructive commands (rm, git reset/clean), uses exact command matching to prevent privilege leakage.
 */
export function deriveSuggestedPattern(toolCall: ToolCallItem): string | undefined {
  if (toolCall.name === 'bash') {
    const rawCmd = typeof toolCall.args?.command === 'string' ? toolCall.args.command : '';
    const command = stripBenignRedirects(rawCmd).trim();
    if (!command) return undefined;

    // Compound commands (containing &&, ;, ||) are safer to match as exact command
    if (/[;&|]/.test(command)) {
      return command;
    }

    const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    if (tokens.length === 0) return undefined;

    const first = tokens[0]?.replace(/^['"]|['"]$/g, '') ?? '';
    const baseFirst = first.split('/').pop() ?? '';

    // Destructive commands: exact match
    if (DESTRUCTIVE_BASH_TOOLS.has(baseFirst)) {
      return command;
    }

    if (baseFirst === 'git') {
      const sub = tokens[1]?.replace(/^['"]|['"]$/g, '');
      if (!sub) return 'git *';
      if (['clean', 'reset', 'restore', 'branch'].includes(sub)) {
        // High-impact git actions: match exact command
        return command;
      }
      return `git ${sub} *`;
    }

    // Package managers and build tools
    if (['pnpm', 'npm', 'yarn', 'bun', 'cargo', 'go', 'make', 'gradle', 'mvn'].includes(baseFirst)) {
      const sub1 = tokens[1]?.replace(/^['"]|['"]$/g, '');
      if (!sub1) return `${baseFirst} *`;
      if (sub1 === 'run' && tokens[2]) {
        const sub2 = tokens[2].replace(/^['"]|['"]$/g, '');
        return `${baseFirst} run ${sub2} *`;
      }
      return `${baseFirst} ${sub1} *`;
    }

    // Common CLIs: prefix wildcard
    return `${baseFirst} *`;
  }

  if (toolCall.name === 'write_file') {
    const rawPath = typeof toolCall.args?.path === 'string' ? toolCall.args.path.replace(/\\/g, '/') : '';
    if (!rawPath) return undefined;
    const parts = rawPath.split('/').filter(Boolean);
    if (parts.length > 1) {
      // Return directory wildcard, e.g. "packages/core/src/**" or "src/**"
      const dir = parts.slice(0, -1).join('/');
      return `${dir}/**`;
    }
    return rawPath;
  }

  return toolCall.name;
}

/**
 * Checks if a given tool call matches a stored permission pattern.
 */
export function matchesPattern(pattern: string, tool: string, toolCall: ToolCallItem): boolean {
  if (tool !== toolCall.name) {
    return false;
  }

  if (tool === 'bash') {
    const rawCmd = typeof toolCall.args?.command === 'string' ? toolCall.args.command : '';
    const command = stripBenignRedirects(rawCmd).trim();
    if (!command) return false;

    if (pattern.endsWith(' *')) {
      const prefix = pattern.slice(0, -2);
      return command === prefix || command.startsWith(prefix + ' ');
    }
    return command === pattern;
  }

  if (tool === 'write_file') {
    const rawPath = typeof toolCall.args?.path === 'string' ? toolCall.args.path.replace(/\\/g, '/') : '';
    if (!rawPath) return false;

    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      return rawPath === prefix || rawPath.startsWith(prefix + '/');
    }
    return rawPath === pattern;
  }

  return pattern === toolCall.name;
}
