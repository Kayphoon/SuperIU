/**
 * Redaction coverage guard for BOTH shells.
 *
 * WHY THIS FILE EXISTS — the same defect class recurred FOUR times in one
 * session, each time at a site the previous fix did not cover:
 *
 *   1. the REST error helpers were redacted (`sendError` / `sendJson`) but the
 *      two `/api/chat` SSE error frames still wrote the RAW `err.message`;
 *   2. `/api/models/fetch` was fixed for the configured key but its
 *      request-scoped `targetKey` — a credential the caller hands over and this
 *      server then sends upstream — was not;
 *   3. the ENV-ONLY key (`OPENAI_API_KEY`, applied by the runner, not by
 *      `settings`) was invisible to every `settings`-derived scan, so a provider
 *      envelope echoing it reached the transcript and the desktop notification;
 *   4. the CLI shell had no redaction at all.
 *
 * Fixing site-by-site does not converge — each fix was correct and each fix left
 * the next site open. This guard makes the invariant mechanical instead: it
 * fails if any of those four regressions is reintroduced, and it does so from the
 * SOURCE, so it runs without a provider, a browser or a credential.
 *
 * INPUT SET — four files:
 *
 *   1. `packages/ui/src/server.ts`      — the two SSE error frames, the
 *                                         `resolvedCredentials` declaration and
 *                                         the five `console.error` sites;
 *   2. `packages/cli/src/index.ts`      — every CLI display sink;
 *   3. `packages/cli/bin/myagent.js`    — the entry point's fatal-error sink;
 *   4. `packages/cli/src/redact.ts`     — the CLI's redaction module, whose
 *                                         `SECRET_PATTERNS` must mirror the
 *                                         console's.
 *
 * CHECK A (exact) — every `write({ type: 'error', … })` frame in `server.ts`
 * carries a `message:` value wrapped in `redactSecrets(…)`. The frames are found
 * by locating every `write(` call in a MASKED copy of the source and requiring a
 * `type:` property whose value is the string `error`; the `message` property is
 * then read as a balanced expression, not by regex, so a nested call or an
 * object inside it cannot truncate the window. A bare expression is a FAIL.
 *
 * CHECK B (exact) — that `redactSecrets` call takes a THIRD argument, and the
 * argument is a resolved-credential list: either a direct
 * `resolvedCredentials(…)` call or an identifier bound to one in the same file.
 * This is the check that catches regression #3: redacting with the pattern set
 * ALONE leaves every credential that has no recognizable shape — a Groq
 * `gsk_…`, a Google `AIza…`, an xAI `xai-…`, or whatever a custom relay issued —
 * travelling to the transcript verbatim, because the only thing that identifies
 * such a key is that the runner RESOLVED it.
 *
 * CHECK C (exact) — `function resolvedCredentials(` exists, reads
 * `getModelRoutes()`, and is referenced at both SSE sites. Deleting it, or
 * bypassing it by redacting from `config.apiKey`/`settings.apiKey`, is the same
 * regression as B wearing a different hat: `settings` is what the runner was
 * built FROM, `getModelRoutes()` is what it resolved TO, and only the latter
 * carries the env fallback and a per-role credential.
 *
 * CHECK D — every `console.error(` in `server.ts` whose template interpolates
 * `resp.text()`, `errorMessage(err)` or `err.message` wraps that value in
 * `redactSecrets(…)`. The server log is a surface too: it is the log a bug
 * report is pasted from, which is exactly the argument the CLI redaction module
 * makes for the terminal.
 *
 * CHECK E — every CLI display sink (`output.write(`, `console.error(`) that
 * interpolates `err.message` or a `message` variable wraps it in
 * `redactSecrets(…)`, and `packages/cli/src/redact.ts` exists and exports
 * `redactSecrets`. This is regression #4: the CLI had NO redaction, so a failed
 * model call printed the provider's own envelope — which echoes the rejected
 * credential — into scrollback.
 *
 * CHECK F (exact) — the `SECRET_PATTERNS` sets in `server.ts` and in
 * `packages/cli/src/redact.ts` are EQUAL, whitespace-normalized. The two files
 * are deliberate mirrors, and a divergence means one shell silently protects
 * less than the other. NO ALLOWLIST exists and none may be added: a legitimate
 * divergence is a decision for the maintainer, not for a list inside a guard.
 * Both sets are printed on failure.
 *
 * SELF-TEST — the detectors are re-run against synthetic sources carrying each
 * historical regression (an unredacted `write({type:'error'})`; a frame whose
 * `redactSecrets` call has only two arguments; a deleted `resolvedCredentials`;
 * an unredacted `console.error(resp.text())`; a CLI sink printing `err.message`
 * raw) and each must be DETECTED — plus the negative half of every pair, where a
 * correctly-redacted site must NOT be reported. A guard whose negative controls
 * cannot fail is decorative, and a guard whose extractor silently finds nothing
 * is worse: decorative AND green. The floors below are the second half of that:
 * every extraction is asserted to have reached real content, so a rename or a
 * broken read fails loudly instead of passing over an empty set.
 *
 * The scan is a copy of `check-cli-i18n.mjs`'s masker with one addition —
 * regex literals are stepped over — because `SECRET_PATTERNS` itself contains a
 * quote inside a regex (`[^"]*`), which the quote-first masker would read as a
 * string and blank across a paren. That mis-read is harmless today (the blanked
 * span happens to be balanced) but it is not guaranteed to stay harmless, so the
 * mask is asserted to leave parens and braces balanced on the real file below.
 *
 * Run: node scripts/check-redaction-coverage.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const UI_SERVER_PATH = path.join(REPO, 'packages/ui/src/server.ts');
const CLI_INDEX_PATH = path.join(REPO, 'packages/cli/src/index.ts');
const CLI_BIN_PATH = path.join(REPO, 'packages/cli/bin/myagent.js');
const CLI_REDACT_PATH = path.join(REPO, 'packages/cli/src/redact.ts');

// --- output -----------------------------------------------------------------

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  → ${detail}` : ''}`);
}

function info(label, detail) {
  console.log(`INFO  ${label}${detail ? `  → ${detail}` : ''}`);
}

// --- generic source scanning ------------------------------------------------

/** Blank a range in a character buffer, preserving newlines so line numbers hold. */
function blankRange(buffer, from, to) {
  for (let index = from; index < to; index += 1) {
    if (buffer[index] !== '\n') buffer[index] = ' ';
  }
}

/** Step over a quoted string starting at the quote at `index`. Returns the offset after it. */
function skipQuoted(source, index) {
  const quote = source[index];
  let cursor = index + 1;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === '\\') {
      cursor += 2;
      continue;
    }
    if (ch === quote) return cursor + 1;
    if (ch === '\n') return cursor;
    cursor += 1;
  }
  return cursor;
}

/** Step over a template literal starting at the backtick at `index`. */
function skipTemplate(source, index) {
  let cursor = index + 1;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === '\\') {
      cursor += 2;
      continue;
    }
    if (ch === '`') return cursor + 1;
    cursor += 1;
  }
  return cursor;
}

/**
 * Whether a `/` at `index` opens a regex literal rather than being a division.
 *
 * A regex can only start where a VALUE may start: after `(`, `,`, `=`, `[`, `{`,
 * `:`, `!`, `&`, `|`, `?`, `;` or the start of the file — never after an
 * identifier, a number, or a closing bracket. The check is made against the
 * buffer as masked SO FAR, so a `/` inside a string has already been consumed by
 * the quote branch and can never reach here.
 */
function regexAllowed(buffer, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(buffer[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  return !/[A-Za-z0-9_$)\]}]/.test(buffer[cursor]);
}

/** Step over a regex literal starting at the `/` at `index`. */
function skipRegex(source, index) {
  let cursor = index + 1;
  let inClass = false;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === '\\') {
      cursor += 2;
      continue;
    }
    if (ch === '\n') return cursor;
    if (inClass) {
      if (ch === ']') inClass = false;
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === '/') {
      cursor += 1;
      while (cursor < source.length && /[a-z]/.test(source[cursor])) cursor += 1;
      return cursor;
    }
    cursor += 1;
  }
  return cursor;
}

/**
 * Blank every non-code region of `source` and record what was blanked.
 *
 * Returns `{ code, strings, templates, source, lineAt }`:
 *   * `code`      — the masked copy. Comments, string bodies (quotes included),
 *                   regex literals and the STATIC parts of template literals are
 *                   spaces; the `${ … }` interpolations stay as code, so a
 *                   `redactSecrets()` written inside an interpolation is still
 *                   found. Braces stay balanced, which is what makes the
 *                   balanced-paren walk below trustworthy.
 *   * `strings`   — `{ start, end, value, line, raw }` for each quoted literal,
 *                   offsets into `source`.
 *   * `templates` — `{ start, end, raw, line }` for each template literal.
 *
 * Template-ness is tracked by an explicit mode stack rather than by regex,
 * because a template can nest inside its own interpolation.
 */
function scanSource(source) {
  const buffer = source.split('');
  const strings = [];
  const templates = [];
  const lineAt = (at) => source.slice(0, at).split('\n').length;
  const stack = [{ kind: 'code' }];
  let index = 0;

  while (index < source.length) {
    const top = stack[stack.length - 1];
    const ch = source[index];

    if (top.kind === 'template') {
      if (ch === '\\') {
        blankRange(buffer, index, index + 2);
        index += 2;
        continue;
      }
      if (ch === '`') {
        templates.push({ start: top.start, end: index + 1, raw: source.slice(top.start, index + 1), line: lineAt(top.start) });
        stack.pop();
        blankRange(buffer, index, index + 1);
        index += 1;
        continue;
      }
      if (ch === '$' && source[index + 1] === '{') {
        stack.push({ kind: 'code', interpolation: true, depth: 0 });
        blankRange(buffer, index, index + 2);
        index += 2;
        continue;
      }
      blankRange(buffer, index, index + 1);
      index += 1;
      continue;
    }

    // Code mode: an interpolation's own closing brace has to be told apart from
    // a brace belonging to an object literal inside it, hence the counter.
    if (top.interpolation) {
      if (ch === '{') {
        top.depth += 1;
        index += 1;
        continue;
      }
      if (ch === '}') {
        if (top.depth === 0) {
          stack.pop();
          blankRange(buffer, index, index + 1);
          index += 1;
          continue;
        }
        top.depth -= 1;
        index += 1;
        continue;
      }
    }

    if (ch === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index);
      const stop = newline === -1 ? source.length : newline;
      blankRange(buffer, index, stop);
      index = stop;
      continue;
    }
    if (ch === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      const stop = close === -1 ? source.length : close + 2;
      blankRange(buffer, index, stop);
      index = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const start = index;
      const end = skipQuoted(source, index);
      strings.push({ start, end, raw: source.slice(start, end), value: source.slice(start + 1, Math.max(start + 1, end - 1)), line: lineAt(start) });
      blankRange(buffer, start, end);
      index = end;
      continue;
    }
    if (ch === '`') {
      stack.push({ kind: 'template', start: index });
      blankRange(buffer, index, index + 1);
      index += 1;
      continue;
    }
    if (ch === '/' && regexAllowed(buffer, index)) {
      const start = index;
      const end = skipRegex(source, index);
      if (end > start + 1) {
        blankRange(buffer, start, end);
        index = end;
        continue;
      }
    }
    index += 1;
  }

  return { code: buffer.join(''), strings, templates, source, lineAt };
}

/**
 * The argument span of the call whose `(` sits at `open`, as absolute offsets.
 *
 * Walks the MASKED code, so a paren inside a string or a comment cannot move the
 * closing offset. Returns null when the call is never closed, which the caller
 * treats as "no window" rather than as an empty one.
 */
function callArguments(code, open) {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const ch = code[index];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { start: open + 1, stop: index };
    }
  }
  return null;
}

/** The `{ … }` block whose opening brace sits at `open`, balanced. */
function braceBlock(code, open) {
  if (open === -1) return null;
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const ch = code[index];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, index + 1);
    }
  }
  return null;
}

/** Every call of `name` in the masked code, with its argument span. */
function callsNamed(scan, name) {
  const pattern = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, 'g');
  const out = [];
  for (const match of scan.code.matchAll(pattern)) {
    const open = match.index + match[0].length - 1;
    const args = callArguments(scan.code, open);
    if (!args) continue;
    out.push({ name, callStart: match.index, open, start: args.start, stop: args.stop, line: scan.lineAt(match.index) });
  }
  return out;
}

/** Every call matching `pattern` in the masked code, with its argument span. */
function callsMatching(scan, pattern, describe) {
  const out = [];
  for (const match of scan.code.matchAll(pattern)) {
    const open = match.index + match[0].length - 1;
    const args = callArguments(scan.code, open);
    if (!args) continue;
    out.push({ name: describe(match[0]), callStart: match.index, open, start: args.start, stop: args.stop, line: scan.lineAt(match.index) });
  }
  return out;
}

const stringsWithin = (scan, from, to) => scan.strings.filter((entry) => entry.start >= from && entry.end <= to);

/** Split an argument span at its TOP-LEVEL commas, as absolute-offset parts. */
function splitTopLevel(code, from, to) {
  const parts = [];
  let depth = 0;
  let start = from;
  for (let index = from; index < to; index += 1) {
    const ch = code[index];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push({ start, stop: index, text: code.slice(start, index).trim() });
      start = index + 1;
    }
  }
  const tail = code.slice(start, to).trim();
  if (tail.length > 0) parts.push({ start, stop: to, text: tail });
  return parts;
}

/**
 * The value expression of a named property inside an object-literal argument.
 *
 * Read as a BALANCED span — depth-aware from the colon to the next top-level
 * comma or the object's closing brace — rather than by a lazy regex, so a nested
 * call (`redactSecrets(errorMessage(err), 2000, resolvedCredentials(runner))`)
 * yields the whole expression instead of its first fragment.
 */
function propertyValue(code, from, to, name) {
  const pattern = new RegExp(`(?<![\\w$.])${name}\\s*:`, 'g');
  for (const match of code.slice(from, to).matchAll(pattern)) {
    const colon = from + match.index + match[0].length;
    let depth = 0;
    let index = colon;
    for (; index < to; index += 1) {
      const ch = code[index];
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']') depth -= 1;
      else if (ch === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (ch === ',' && depth === 0) break;
    }
    return { start: colon, stop: index, text: code.slice(colon, index).trim() };
  }
  return null;
}

// --- CHECK A/B/C: the SSE error frames --------------------------------------

/**
 * Every `write({ type: 'error', … })` frame in `scan`.
 *
 * The frame is identified by the `type` property holding the string `error`,
 * which is read from the recorded string literals rather than from a raw regex:
 * a comment or a string mentioning `type: 'error'` cannot then be mistaken for a
 * frame.
 */
function sseErrorFrames(scan) {
  const frames = [];
  for (const call of callsNamed(scan, 'write')) {
    const typeString = stringsWithin(scan, call.start, call.stop).find((entry) =>
      /type\s*:\s*$/.test(scan.code.slice(Math.max(call.start, entry.start - 16), entry.start)) && entry.value === 'error'
    );
    if (!typeString) continue;
    const value = propertyValue(scan.code, call.start, call.stop, 'message');
    frames.push({ line: call.line, value, redacted: value ? /^redactSecrets\s*\(/.test(value.text) : false });
  }
  return frames;
}

/** Identifiers bound to a `resolvedCredentials(…)` call anywhere in `scan`. */
function resolvedCredentialBindings(scan) {
  const names = new Set();
  for (const match of scan.code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*resolvedCredentials\s*\(/g)) {
    names.add(match[1]);
  }
  return names;
}

/** The argument list of the `redactSecrets(…)` a `message` value opens with. */
function redactionArguments(scan, value) {
  if (!value) return null;
  const open = scan.code.indexOf('(', value.start);
  if (open === -1 || open >= value.stop) return null;
  const args = callArguments(scan.code, open);
  if (!args) return null;
  return splitTopLevel(scan.code, args.start, args.stop);
}

/**
 * The two ways an SSE error frame can leak: a bare `message:` expression, and a
 * `redactSecrets(…)` call that redacts by PATTERN ONLY (no resolved-credential
 * list). The second is the one regression #3 wore.
 */
function sseFrameFindings(scan) {
  const frames = sseErrorFrames(scan);
  const bindings = resolvedCredentialBindings(scan);
  const unredacted = [];
  const patternsOnly = [];
  for (const frame of frames) {
    const args = redactionArguments(scan, frame.value);
    const third = args && args.length >= 3 ? args[2].text : null;
    if (!frame.redacted) {
      unredacted.push({ line: frame.line, text: frame.value ? frame.value.text : '(no message property)' });
      continue;
    }
    const resolved = third !== null && (/^resolvedCredentials\s*\(/.test(third) || bindings.has(third));
    if (!resolved) patternsOnly.push({ line: frame.line, third: third === null ? '(missing — only two arguments)' : third });
  }
  return { frames, bindings, unredacted, patternsOnly };
}

/** The `function resolvedCredentials(…)` declaration, its body, and its route read. */
function resolvedCredentialsDeclaration(scan) {
  const match = /function\s+resolvedCredentials\s*\(/.exec(scan.code);
  if (!match) return { declared: false, readsRoutes: false, body: null };
  const open = scan.code.indexOf('(', match.index);
  const args = callArguments(scan.code, open);
  const braceStart = scan.code.indexOf('{', args ? args.stop : open);
  const body = braceBlock(scan.code, braceStart);
  return { declared: true, body, readsRoutes: body !== null && /getModelRoutes\s*\(\s*\)/.test(body) };
}

// --- CHECK D: the server log sites ------------------------------------------

/** Upstream-derived expressions that must not reach a log unwrapped. */
const LOG_DANGEROUS = [
  { name: 'resp.text()', pattern: /\bresp\.text\s*\(\s*\)/g },
  { name: 'errorMessage(...)', pattern: /\berrorMessage\s*\(/g },
  { name: 'err.message', pattern: /\berr\.message\b/g }
];

/**
 * `console.error(…)` sites that interpolate upstream text outside a
 * `redactSecrets(…)` argument.
 */
function logSiteFindings(scan) {
  const redactions = callsNamed(scan, 'redactSecrets').map((call) => ({ start: call.start, stop: call.stop }));
  const sites = callsMatching(scan, /(?<![\w$.])console\.error\s*\(/g, () => 'console.error');
  const findings = [];
  for (const site of sites) {
    for (const danger of LOG_DANGEROUS) {
      for (const match of scan.code.slice(site.start, site.stop).matchAll(danger.pattern)) {
        const at = site.start + match.index;
        if (redactions.some((span) => at >= span.start && at <= span.stop)) continue;
        findings.push({ line: site.line, name: danger.name });
      }
    }
  }
  return { sites, findings };
}

// --- CHECK E: the CLI display sinks -----------------------------------------

/** CLI sink calls whose argument interpolates an error-bearing value. */
const CLI_DANGEROUS = [
  { name: 'err.message', pattern: /\berr\.message\b/g },
  // A bare `message` variable, but not the `message:` key of a `tr()` params
  // object — the key is a label, the value is the thing that must be redacted —
  // and not a property access like `err.message`, which the pattern above owns.
  // Without the lookbehind one raw `err.message` would be reported twice, which
  // makes a count assertion ambiguous rather than making the guard stricter.
  { name: 'message', pattern: /(?<![\w$.])message\b(?!\s*:)/g }
];

function cliSinkFindings(scan) {
  const redactions = callsNamed(scan, 'redactSecrets').map((call) => ({ start: call.start, stop: call.stop }));
  const sinks = callsMatching(scan, /(?<![\w$.])(?:output\.write|console\.error)\s*\(/g, (text) => text.trim());
  const findings = [];
  let dangerousSites = 0;
  for (const sink of sinks) {
    const hits = [];
    for (const danger of CLI_DANGEROUS) {
      for (const match of scan.code.slice(sink.start, sink.stop).matchAll(danger.pattern)) {
        const at = sink.start + match.index;
        hits.push({ at, name: danger.name, covered: redactions.some((span) => at >= span.start && at <= span.stop) });
      }
    }
    if (hits.length === 0) continue;
    dangerousSites += 1;
    for (const hit of hits) {
      if (!hit.covered) findings.push({ line: sink.line, name: hit.name, sink: sink.name });
    }
  }
  return { sinks, dangerousSites, findings };
}

// --- CHECK F: the two pattern sets agree ------------------------------------

/**
 * The regex literals of a `const SECRET_PATTERNS = [ … ];` block, read from the
 * RAW source and sliced by the declaration itself.
 *
 * Raw rather than masked on purpose: the fourth pattern embeds a `"` character
 * class, which any quote-first masker reads as the start of a string. Slicing by
 * the declaration keeps the read anchored to the one block that matters, and the
 * count is floored so a renamed or emptied block cannot read as "equal".
 */
function extractSecretPatterns(source) {
  const marker = 'const SECRET_PATTERNS';
  const start = source.indexOf(marker);
  if (start === -1) return { error: `${marker} was not found` };
  const end = source.indexOf('];', start);
  if (end === -1) return { error: `${marker} block is not closed with ];` };
  const block = source.slice(start, end);
  const patterns = [...block.matchAll(/\/(?:\\.|\[(?:[^\]\\]|\\.)*\]|[^\/\\\n])+\/[a-z]*/g)].map((match) =>
    match[0].replace(/\s+/g, '')
  );
  return { block, patterns };
}

// --- the sources ------------------------------------------------------------

const SOURCES = [
  { id: 'server', label: 'packages/ui/src/server.ts', path: UI_SERVER_PATH },
  { id: 'cli', label: 'packages/cli/src/index.ts', path: CLI_INDEX_PATH },
  { id: 'bin', label: 'packages/cli/bin/myagent.js', path: CLI_BIN_PATH }
];

const scans = {};
let readFailure = null;
for (const entry of SOURCES) {
  try {
    scans[entry.id] = { ...entry, scan: scanSource(fs.readFileSync(entry.path, 'utf-8')) };
  } catch (error) {
    readFailure = `${entry.label}: ${error.message}`;
  }
}

let redactModuleSource = '';
try {
  redactModuleSource = fs.readFileSync(CLI_REDACT_PATH, 'utf-8');
} catch (error) {
  readFailure = readFailure ?? `packages/cli/src/redact.ts: ${error.message}`;
}

if (readFailure) {
  console.error(`FAIL  could not read the redaction guard's input set  →  ${readFailure}`);
  process.exit(1);
}

const serverScan = scans.server.scan;

check(
  'extraction reached every redaction source',
  Object.values(scans).every((entry) => entry.scan.code.length > 0),
  Object.values(scans)
    .map((entry) => `${entry.id}=${entry.scan.code.length} chars`)
    .join(' ')
);

// The masker's one assumption, asserted rather than trusted: a regex literal is
// stepped over as a unit, so the `"` inside `SECRET_PATTERNS` cannot blank a
// paren and slide every window below it.
const balanceOf = (code) => {
  let depth = 0;
  for (const ch of code) {
    if (ch === '(' || ch === '{') depth += 1;
    else if (ch === ')' || ch === '}') depth -= 1;
  }
  return depth;
};

check(
  'the mask leaves parens and braces balanced in every source',
  Object.values(scans).every((entry) => balanceOf(entry.scan.code) === 0),
  Object.values(scans)
    .map((entry) => `${entry.id}=${balanceOf(entry.scan.code)}`)
    .join(' ')
);

// --- CHECK A + B: the SSE error frames are redacted with resolved creds -----

/** Minimum SSE error frames (measured 2: the in-turn `onError` and the outer `catch`). */
const SSE_FRAME_FLOOR = 2;
/** Minimum characters of `resolvedCredentials`' body (measured 210, floor ~52%). */
const RESOLVED_CREDENTIALS_BODY_FLOOR = 110;

const sse = sseFrameFindings(serverScan);
const credentialSource = resolvedCredentialsDeclaration(serverScan);

check(
  'the SSE error-frame extraction found the frames it guards',
  sse.frames.length >= SSE_FRAME_FLOOR,
  `${sse.frames.length} frame(s) (floor >= ${SSE_FRAME_FLOOR}) at line(s) ${sse.frames.map((frame) => frame.line).join(', ')}`
);

check(
  'CHECK A — every SSE error frame redacts its message',
  sse.unredacted.length === 0,
  sse.unredacted.length === 0
    ? `${sse.frames.length} frame(s) all wrapped in redactSecrets(...)`
    : sse.unredacted.map((entry) => `packages/ui/src/server.ts:${entry.line}  message: ${entry.text}`).join('\n      ')
);

check(
  'CHECK B — every SSE frame redacts with resolved credentials, not patterns alone',
  sse.patternsOnly.length === 0,
  sse.patternsOnly.length === 0
    ? `3rd argument is a resolved-credential list at all ${sse.frames.length} frame(s)`
    : sse.patternsOnly.map((entry) => `packages/ui/src/server.ts:${entry.line}  3rd argument: ${entry.third}`).join('\n      ')
);

check(
  'CHECK C — resolvedCredentials exists and reads the RESOLVED routes',
  credentialSource.declared && credentialSource.readsRoutes,
  credentialSource.declared
    ? credentialSource.readsRoutes
      ? `function body is ${credentialSource.body.length} chars and reads getModelRoutes()`
      : 'the function exists but never reads getModelRoutes() — settings-derived, so the env fallback is invisible'
    : 'function resolvedCredentials( was not found'
);

check(
  'CHECK C — resolvedCredentials is referenced at every SSE frame',
  sse.frames.length >= SSE_FRAME_FLOOR && sse.patternsOnly.length === 0 && sse.unredacted.length === 0,
  sse.patternsOnly.length + sse.unredacted.length === 0
    ? `${sse.frames.length} frame(s) reach it (direct call or bound identifier)`
    : `${sse.patternsOnly.length + sse.unredacted.length} frame(s) do not`
);

info(
  'resolved-credential identifiers bound in packages/ui/src/server.ts',
  sse.bindings.size === 0 ? 'none (every frame calls resolvedCredentials inline)' : [...sse.bindings].join(', ')
);

// --- CHECK D: the server log sites ------------------------------------------

/** Minimum `console.error` sites in server.ts (measured 5, floor 20% below). */
const LOG_SITE_FLOOR = 4;

const logSites = logSiteFindings(serverScan);

check(
  'the log-site extraction found the console.error sites',
  logSites.sites.length >= LOG_SITE_FLOOR,
  `${logSites.sites.length} site(s) (floor >= ${LOG_SITE_FLOOR}) at line(s) ${logSites.sites.map((site) => site.line).join(', ')}`
);

check(
  'CHECK D — every log site relaying upstream text redacts it',
  logSites.findings.length === 0,
  logSites.findings.length === 0
    ? `${logSites.sites.length} console.error site(s), every upstream expression inside redactSecrets(...)`
    : logSites.findings.map((entry) => `packages/ui/src/server.ts:${entry.line}  ${entry.name} interpolated unwrapped`).join('\n      ')
);

// --- CHECK E: the CLI display sinks -----------------------------------------

/** Minimum CLI sink sites interpolating an error value (measured 4, floor 25% below). */
const CLI_SINK_FLOOR = 3;

const cliSinks = {
  cli: cliSinkFindings(scans.cli.scan),
  bin: cliSinkFindings(scans.bin.scan)
};
const cliDangerousSites = Object.values(cliSinks).reduce((sum, result) => sum + result.dangerousSites, 0);
const cliFindings = Object.entries(cliSinks).flatMap(([id, result]) => result.findings.map((finding) => ({ id, ...finding })));

check(
  'the CLI sink extraction found the error-bearing sinks',
  cliDangerousSites >= CLI_SINK_FLOOR,
  `${cliDangerousSites} sink(s) interpolating an error value (floor >= ${CLI_SINK_FLOOR}) — ${Object.entries(cliSinks)
    .map(([id, result]) => `${id}=${result.dangerousSites}/${result.sinks.length}`)
    .join(', ')}`
);

check(
  'CHECK E — every CLI sink interpolating an error value redacts it',
  cliFindings.length === 0,
  cliFindings.length === 0
    ? `${cliDangerousSites} sink(s), every err.message / message inside redactSecrets(...)`
    : cliFindings.map((entry) => `${entry.id === 'bin' ? 'packages/cli/bin/myagent.js' : 'packages/cli/src/index.ts'}:${entry.line}  ${entry.sink} interpolates ${entry.name} unwrapped`).join('\n      ')
);

check(
  'CHECK E — packages/cli/src/redact.ts exists and exports redactSecrets',
  /export\s+function\s+redactSecrets\s*\(/.test(redactModuleSource),
  /export\s+function\s+redactSecrets\s*\(/.test(redactModuleSource)
    ? 'exported'
    : 'no `export function redactSecrets(` in packages/cli/src/redact.ts'
);

// --- CHECK F: the two pattern sets are mirrors ------------------------------

/** Minimum patterns in each `SECRET_PATTERNS` set (measured 4, floor 3). */
const SECRET_PATTERN_FLOOR = 3;

const serverPatterns = extractSecretPatterns(serverScan.source);
const cliPatterns = extractSecretPatterns(redactModuleSource);

check(
  'the SECRET_PATTERNS blocks are both readable',
  !serverPatterns.error && !cliPatterns.error,
  serverPatterns.error || cliPatterns.error || 'both blocks sliced and read'
);

check(
  'the SECRET_PATTERNS extraction found real patterns',
  (serverPatterns.patterns ?? []).length >= SECRET_PATTERN_FLOOR && (cliPatterns.patterns ?? []).length >= SECRET_PATTERN_FLOOR,
  `server=${(serverPatterns.patterns ?? []).length} cli=${(cliPatterns.patterns ?? []).length} (floor >= ${SECRET_PATTERN_FLOOR})`
);

const serverPatternSet = [...new Set(serverPatterns.patterns ?? [])].sort();
const cliPatternSet = [...new Set(cliPatterns.patterns ?? [])].sort();
const patternsEqual = serverPatternSet.length > 0 && serverPatternSet.join('\u0000') === cliPatternSet.join('\u0000');

check(
  'CHECK F — the web and CLI redaction pattern sets are equal',
  patternsEqual,
  patternsEqual
    ? `${serverPatternSet.length} identical pattern(s): ${serverPatternSet.join(' , ')}`
    : `server (${serverPatternSet.length}): ${serverPatternSet.join(' , ')}\n      cli (${cliPatternSet.length}): ${cliPatternSet.join(' , ')}`
);

// --- self-test: the detectors must be able to fail --------------------------
//
// Each detector is re-run against a synthetic source carrying a KNOWN defect —
// one per historical regression — and each must report it, with the negative
// half of the pair (the correctly-redacted site) reporting nothing. A control
// that cannot fail proves nothing. The real extractions are asserted against the
// live tree in the same block, so a floor cannot drift apart from what it
// measures.

{
  // (A) An unredacted error frame must be reported; a redacted one must not.
  const bareFrame = sseFrameFindings(scanSource("function f() { write({ type: 'error', message: err.message, phase }); }\n"));
  check(
    'self-test: an unredacted write({type:error}) frame is detected',
    bareFrame.frames.length === 1 && bareFrame.unredacted.length === 1 && bareFrame.patternsOnly.length === 0,
    `${bareFrame.frames.length} frame(s), ${bareFrame.unredacted.length} unredacted: ${bareFrame.unredacted.map((entry) => entry.text).join(' | ') || 'no hit'}`
  );
  const goodFrame = sseFrameFindings(
    scanSource("function f() { const secrets = resolvedCredentials(target); write({ type: 'error', message: redactSecrets(err.message, 2000, secrets), phase }); }\n")
  );
  check(
    'self-test: a correctly redacted frame is NOT reported',
    goodFrame.frames.length === 1 && goodFrame.unredacted.length === 0 && goodFrame.patternsOnly.length === 0,
    `${goodFrame.frames.length} frame(s), ${goodFrame.unredacted.length + goodFrame.patternsOnly.length} finding(s)`
  );
  const inlineFrame = sseFrameFindings(
    scanSource("function f() { write({ type: 'error', message: redactSecrets(errorMessage(err), 2000, resolvedCredentials(runner)) }); }\n")
  );
  check(
    'self-test: an inline resolvedCredentials(...) third argument is accepted without a binding',
    inlineFrame.unredacted.length === 0 && inlineFrame.patternsOnly.length === 0,
    `${inlineFrame.patternsOnly.length} finding(s)`
  );

  // (B) A frame that redacts with patterns only — the env-only-key regression.
  const twoArgFrame = sseFrameFindings(scanSource("function f() { write({ type: 'error', message: redactSecrets(err.message, 300) }); }\n"));
  check(
    'self-test: a frame with only two redactSecrets arguments is detected',
    twoArgFrame.frames.length === 1 && twoArgFrame.unredacted.length === 0 && twoArgFrame.patternsOnly.length === 1,
    `third argument reported as: ${twoArgFrame.patternsOnly.map((entry) => entry.third).join(' | ') || 'no hit'}`
  );
  const unresolvedBinding = sseFrameFindings(
    scanSource("function f() { const secrets = settingsApiKeys(); write({ type: 'error', message: redactSecrets(err.message, 2000, secrets) }); }\n")
  );
  check(
    'self-test: a third argument bound to something other than resolvedCredentials is detected',
    unresolvedBinding.patternsOnly.length === 1,
    `third argument reported as: ${unresolvedBinding.patternsOnly.map((entry) => entry.third).join(' | ') || 'no hit'}`
  );

  // A `type: 'error'` mentioned in a comment or a string is not a frame.
  const decoyFrames = sseErrorFrames(scanSource("// write({ type: 'error', message: err.message })\nconst note = \"write({ type: 'error', message: raw })\";\n"));
  check(
    'self-test: a frame written inside a comment or a string is not read as a frame',
    decoyFrames.length === 0,
    `${decoyFrames.length} frame(s) found (expected 0)`
  );

  // (C) A deleted resolvedCredentials must be detected, and its route read too.
  const noDeclaration = resolvedCredentialsDeclaration(scanSource("function other() { return 1; }\n"));
  check(
    'self-test: a deleted resolvedCredentials is detected',
    noDeclaration.declared === false && noDeclaration.readsRoutes === false,
    `declared=${noDeclaration.declared}`
  );
  const settingsDerived = resolvedCredentialsDeclaration(scanSource("function resolvedCredentials(target) {\n  return [settings.apiKey];\n}\n"));
  check(
    'self-test: a resolvedCredentials that never reads getModelRoutes() is detected',
    settingsDerived.declared === true && settingsDerived.readsRoutes === false,
    `declared=${settingsDerived.declared} readsRoutes=${settingsDerived.readsRoutes}`
  );
  const routeDerived = resolvedCredentialsDeclaration(
    scanSource("function resolvedCredentials(target) {\n  for (const route of Object.values(target.getModelRoutes())) { use(route.apiKey); }\n  return [];\n}\n")
  );
  check(
    'self-test: a resolvedCredentials reading getModelRoutes() is accepted',
    routeDerived.declared === true && routeDerived.readsRoutes === true,
    `body=${routeDerived.body.length} chars`
  );

  // (D) An unredacted log relay must be reported; a redacted one must not.
  const bareLog = logSiteFindings(scanSource('function f() { console.error(`[models/fetch] ${resp.text()}`); }\n'));
  check(
    'self-test: an unredacted console.error(resp.text()) is detected',
    bareLog.findings.length === 1 && bareLog.findings[0].name === 'resp.text()',
    bareLog.findings.map((entry) => entry.name).join(' | ') || 'no hit'
  );
  const bareErrLog = logSiteFindings(scanSource('function f() { console.error(`[server] failed: ${errorMessage(err)}`); }\n'));
  check(
    'self-test: an unredacted console.error(errorMessage(err)) is detected',
    bareErrLog.findings.length === 1 && bareErrLog.findings[0].name === 'errorMessage(...)',
    bareErrLog.findings.map((entry) => entry.name).join(' | ') || 'no hit'
  );
  const goodLog = logSiteFindings(
    scanSource('function f() { console.error(`[models/fetch] ${redactSecrets(await resp.text(), 500, [targetKey])}`); }\n')
  );
  check(
    'self-test: a correctly redacted log site is NOT reported',
    goodLog.sites.length === 1 && goodLog.findings.length === 0,
    `${goodLog.sites.length} site(s), ${goodLog.findings.length} finding(s)`
  );
  const unrelatedLog = logSiteFindings(scanSource('function f() { console.error(`[server] listening on ${port}`); }\n'));
  check(
    'self-test: a log site with no upstream expression is NOT reported',
    unrelatedLog.sites.length === 1 && unrelatedLog.findings.length === 0,
    `${unrelatedLog.findings.length} finding(s)`
  );

  // (E) A raw CLI sink must be reported; a redacted one must not.
  const bareCli = cliSinkFindings(scanSource('function f() { output.write(pc.red(err.message)); }\n'));
  check(
    'self-test: a CLI sink printing err.message raw is detected',
    bareCli.findings.length === 1 && bareCli.findings[0].name === 'err.message',
    bareCli.findings.map((entry) => `${entry.sink}:${entry.name}`).join(' | ') || 'no hit'
  );
  const bareMessage = cliSinkFindings(scanSource("function f() { console.error(pc.red(t(lang, 'cli.fatal', { message }))); }\n"));
  check(
    'self-test: a CLI sink printing a bare message variable is detected',
    bareMessage.findings.length === 1 && bareMessage.findings[0].name === 'message',
    bareMessage.findings.map((entry) => `${entry.sink}:${entry.name}`).join(' | ') || 'no hit'
  );
  const goodCli = cliSinkFindings(
    scanSource("function f() { console.error(pc.red(t(lang, 'cli.fatal', { message: redactSecrets(message) }))); }\n")
  );
  check(
    'self-test: a correctly redacted CLI sink is NOT reported (the tr() params key is not the value)',
    goodCli.dangerousSites === 1 && goodCli.findings.length === 0,
    `${goodCli.dangerousSites} dangerous site(s), ${goodCli.findings.length} finding(s)`
  );
  const goodCliRunner = cliSinkFindings(scanSource('function f() { output.write(pc.red(redactSecrets(err.message, runner))); }\n'));
  check(
    'self-test: a CLI sink redacting err.message with the runner is NOT reported',
    goodCliRunner.findings.length === 0,
    `${goodCliRunner.findings.length} finding(s)`
  );

  // (F) The pattern-set comparison must fail on a divergence, in BOTH
  // directions, and must not be satisfied by an emptied block.
  const leftPatterns = extractSecretPatterns('const SECRET_PATTERNS: X = [\n  [/\\bsk-[A-Za-z0-9_-]{6,}/gi, "[redacted]"]\n];\n');
  const rightPatterns = extractSecretPatterns('const SECRET_PATTERNS: X = [\n  [/\\bsk-[A-Za-z0-9_-]{6,}/gi, "[redacted]"],\n  [/\\bgh[pousr]_[A-Za-z0-9]{16,}/gi, "[redacted]"]\n];\n');
  const leftSet = [...new Set(leftPatterns.patterns)].sort();
  const rightSet = [...new Set(rightPatterns.patterns)].sort();
  check(
    'self-test: a diverging pattern set is detected (one shell protecting less)',
    leftSet.join('\u0000') !== rightSet.join('\u0000') && rightSet.length === 2,
    `left=${leftSet.length} right=${rightSet.length}`
  );
  const identical = extractSecretPatterns('const SECRET_PATTERNS: X = [\n  [/\\bsk-[A-Za-z0-9_-]{6,}/gi, "[redacted]"]\n];\n');
  check(
    'self-test: identical pattern sets compare equal, whitespace-insensitively',
    [...new Set(identical.patterns)].sort().join('\u0000') === leftSet.join('\u0000'),
    `identical=${[...new Set(identical.patterns)].length} left=${leftSet.length}`
  );
  check(
    'self-test: an emptied or renamed SECRET_PATTERNS block is an error, not an empty set',
    Boolean(extractSecretPatterns('const OTHER = [];\n').error) &&
      Boolean(extractSecretPatterns('const SECRET_PATTERNS = [\n  [x, y]\n').error),
    'both an absent block and an unclosed one are reported'
  );

  // The real extractions are asserted against the live tree here, in the same
  // block, so the floors above cannot drift away from what they measure.
  check(
    'self-test: the real sources are measured where the floors claim they are',
    sse.frames.length >= SSE_FRAME_FLOOR &&
      logSites.sites.length >= LOG_SITE_FLOOR &&
      cliDangerousSites >= CLI_SINK_FLOOR &&
      (credentialSource.body?.length ?? 0) >= RESOLVED_CREDENTIALS_BODY_FLOOR &&
      serverPatternSet.length >= SECRET_PATTERN_FLOOR,
    `frames=${sse.frames.length} logSites=${logSites.sites.length} cliSinks=${cliDangerousSites} resolvedCredentialsBody=${credentialSource.body?.length ?? 0} patterns=${serverPatternSet.length}`
  );
}

console.log(failures === 0 ? '\nRedaction coverage guard passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
