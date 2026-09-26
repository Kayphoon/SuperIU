/**
 * CLI localization guard for the terminal shell.
 *
 * WHY THIS FILE EXISTS — a measured, not assumed, blind spot.
 *
 * The repository already shipped two localization guards, and BOTH were green
 * over a CLI shell whose `tr()` keys resolved nowhere:
 *
 *   * `scripts/check-ui-i18n.mjs` scans `packages/ui/public/*` only. The CLI is
 *     not in its input set, so not one of its axes covers a terminal string.
 *   * `scripts/check-dict-parity.mjs` opens `packages/cli/src/index.ts` but reads
 *     it ONLY as a `mapFile`: it extracts the three word-map literals
 *     (`riskWordKeys`, `reviewerWordKeys`, `modeWordKeys`) and compares their key
 *     NAMES across dictionaries. It never resolves the `tr()` key literals the
 *     CLI actually passes, and it never opens `bin/myagent.js` at all. So a key
 *     the tables do not define — which `t()` renders as the raw key string, the
 *     degrade-visibly path in `language.ts` — was invisible.
 *
 * The consequence was reproduced, not reasoned about: planting literal English
 * into a CLI `console.log` AND planting a nonexistent `tr('cli.zzzMissing')`
 * into `packages/cli/src/index.ts` left BOTH guards green (exit 0). CLI key
 * resolution was unguarded. That is the defect this file closes.
 *
 * INPUT SET — four files:
 *
 *   1. `packages/cli/src/index.ts`      — every `tr()` / `t()` key, every display
 *                                         sink, and the three enum word maps;
 *   2. `packages/cli/bin/myagent.js`    — the entry point, which reaches the
 *                                         dictionary through its own `t()` call
 *                                         on the fatal-error path;
 *   3. `packages/cli/src/language.ts`   — the dictionary, both tables;
 *   4. `packages/core/src/review/types.ts` + `packages/core/src/types.ts`
 *                                       — the enums the word maps must cover.
 *
 * THE DICTIONARY SLICING TRAP. `language.ts` declares one object holding two
 * tables (`zh:` / `en:`). A whole-file key scan yields the UNION of both tables,
 * which makes every parity assertion vacuous — a key present in exactly one
 * table would still "resolve". Each table is therefore sliced by its literal
 * boundary (`\n  zh: {` → `\n  en: {` → `\n};`) before a single key is read,
 * and each block is asserted non-empty. This is the same slicing discipline
 * `check-dict-parity.mjs` uses (its `readTable`), applied to the same file's
 * tables from this guard's own side. The slice is re-implemented here rather
 * than imported because that script has no export surface — importing it would
 * EXECUTE it — and it is a script, not a module of shared helpers.
 *
 * CHECK A (exact) — every `tr()` key literal resolves in BOTH tables. The
 * call's argument list is read by balanced-paren matching over a MASKED copy of
 * the source (comments, string bodies and the static parts of template literals
 * blanked, `${ … }` interpolations left as code), so a `tr(` inside a comment or
 * a brace inside a string cannot move the window. The mask is not merely
 * cosmetic: a `};` inside a string value is exactly what truncates a naive scan.
 * The window — not a `tr('…')` regex — is what is read, because a key can arrive
 * through a fallback: `tr(modeWordKeys[mode] ?? 'cli.status.modeUnknown')`. The
 * regex form finds 70 keys here; the window form finds 74. The four it misses
 * are the `??` fallbacks, which are the keys a renamed map would actually break
 * first. Literals that CANNOT be resolved statically — a template literal
 * (`` tr(`status.${x}`) ``) and anything not `segment.segment` key-shaped — are
 * not dropped: they are printed as INFO, and the prefix of every skipped
 * template is checked against a family that expands it (see check C).
 *
 * CHECK B (exact) — the two tables agree. Identical key sets in both
 * directions; `zh`-only and `en`-only must both be empty, and the failure names
 * every asymmetric key. Duplicate keys inside one table are reported too: a
 * duplicate is a silent overwrite, and it makes the parity count a lie. NO
 * ALLOWLIST exists and none may be added: an asymmetry here is a real defect or
 * it is a deliberate divergence, and a deliberate divergence is a decision for
 * the maintainer, not for a list inside a guard.
 *
 * CHECK C (exact) — the enum word-maps are complete. Each of the three maps is
 * parsed out of `index.ts` and every one of its VALUE keys must resolve in both
 * tables; separately, each map's key set must equal the core enum it translates
 * (`RiskLevel`, the `reviewedBy` property union and `AutoReviewMode`), read from
 * `packages/core/src/review/types.ts`. A map the parser cannot find, an EMPTY
 * map and a map missing an enum value are three distinct failures and are
 * reported as such — an emptied map must not be readable as an unmapped enum.
 * The same section expands the one dynamic key family the CLI has: the template
 * `` tr(`status.${status.state}`) `` carries the prefix `status.`, which is
 * enumerated against `AgentStatus` (`packages/core/src/types.ts`) and every
 * member resolved. A dynamic prefix no family expands is a FAIL, not an INFO,
 * because an unexpanded prefix is precisely a hole a literal scan cannot see.
 *
 * CHECK D — newly-hardcoded English in a DISPLAY position, against a PINNED
 * BASELINE. The target is a literal handed to a display sink (`console.log`,
 * `output.write`, `pc.<color>(…)`, `rl.setPrompt`, `rl.question`) that is NOT
 * inside a `tr()`/`t()` call. The rule that makes this check usable is the
 * baseline: `BASELINE_DISPLAY_LITERALS` pins the pre-existing, accepted corpus
 * EXACTLY, and only a literal OUTSIDE it fails. A generic prose heuristic that
 * fires on the existing corpus is a permanent noise source, and the usual
 * response to noise is to loosen the threshold until the check detects nothing —
 * which is how this class of check dies. The measured corpus is nine slash
 * command tokens (`/status`, `/help`, …); they are commands the user TYPES, not
 * copy, so they are correct to leave untranslated and are pinned rather than
 * rewritten. Every other display literal in the shell already reaches the
 * screen through `tr()`.
 *
 * SELF-TEST — the detectors are re-run against synthetic sources carrying known
 * defects (a nonexistent key, a one-sided table, a raw English display literal,
 * a word map missing an enum value) and each must be DETECTED. A guard whose
 * negative controls cannot fail is decorative, and a guard whose extractor
 * silently finds nothing is worse: it is decorative AND green. The floors below
 * are the second half of that: every extraction is asserted to have reached real
 * content, so a rename or a broken read fails loudly instead of passing over an
 * empty set. The floors sit 25–30% below the measured values, following the
 * margin convention of the two existing guards.
 *
 * Run: node scripts/check-cli-i18n.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CLI_INDEX_PATH = path.join(REPO, 'packages/cli/src/index.ts');
const CLI_BIN_PATH = path.join(REPO, 'packages/cli/bin/myagent.js');
const CLI_LANGUAGE_PATH = path.join(REPO, 'packages/cli/src/language.ts');
const CORE_REVIEW_TYPES_PATH = path.join(REPO, 'packages/core/src/review/types.ts');
const CORE_TYPES_PATH = path.join(REPO, 'packages/core/src/types.ts');

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
 * Blank every non-code region of `source` and record what was blanked.
 *
 * Returns `{ code, strings, templates, source, lineAt }`:
 *   * `code`      — the masked copy. Comments, string bodies (quotes included)
 *                   and the STATIC parts of template literals are spaces; the
 *                   `${ … }` interpolations stay as code, so `tr()` calls
 *                   written inside an interpolation are still found. Braces stay
 *                   balanced, which is what makes the balanced-paren walk below
 *                   trustworthy.
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
    index += 1;
  }

  return { code: buffer.join(''), strings, templates, source, lineAt };
}

/**
 * The argument span of the call whose `(` sits at `open`, as absolute offsets.
 *
 * Walks the MASKED code, so a paren inside a string or a comment cannot move
 * the closing offset. Returns null when the call is never closed, which the
 * caller treats as "no window" rather than as an empty one.
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
const templatesWithin = (scan, from, to) => scan.templates.filter((entry) => entry.start >= from && entry.end <= to);

/** The static text of a template literal: its raw source minus every `${ … }`. */
function staticTemplateText(raw) {
  let out = '';
  let index = 1;
  const stop = raw.length - 1;
  while (index < stop) {
    const ch = raw[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === '$' && raw[index + 1] === '{') {
      let depth = 1;
      index += 2;
      while (index < stop && depth > 0) {
        const inner = raw[index];
        if (inner === '\\') {
          index += 2;
          continue;
        }
        if (inner === "'" || inner === '"') {
          index = skipQuoted(raw, index);
          continue;
        }
        if (inner === '`') {
          index = skipTemplate(raw, index);
          continue;
        }
        if (inner === '{') depth += 1;
        else if (inner === '}') depth -= 1;
        index += 1;
      }
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

// --- the sources ------------------------------------------------------------

const SOURCES = [
  { id: 'cli', label: 'packages/cli/src/index.ts', path: CLI_INDEX_PATH },
  { id: 'bin', label: 'packages/cli/bin/myagent.js', path: CLI_BIN_PATH }
];

const cliScans = {};
let readFailure = null;
for (const entry of SOURCES) {
  try {
    cliScans[entry.id] = { ...entry, scan: scanSource(fs.readFileSync(entry.path, 'utf-8')) };
  } catch (error) {
    readFailure = `${entry.label}: ${error.message}`;
  }
}

let languageSource = '';
let reviewTypesSource = '';
let coreTypesSource = '';
try {
  languageSource = fs.readFileSync(CLI_LANGUAGE_PATH, 'utf-8');
  reviewTypesSource = fs.readFileSync(CORE_REVIEW_TYPES_PATH, 'utf-8');
  coreTypesSource = fs.readFileSync(CORE_TYPES_PATH, 'utf-8');
} catch (error) {
  readFailure = readFailure ?? error.message;
}

if (readFailure) {
  console.error(`FAIL  could not read the CLI localization guard's input set  →  ${readFailure}`);
  process.exit(1);
}

// Every `tr()` / `t()` call in both CLI sources. `tr` is the CLI's local wrapper
// over `t`; `t` is the dictionary lookup the bin calls directly.
for (const entry of Object.values(cliScans)) {
  entry.translateCalls = [...callsNamed(entry.scan, 'tr'), ...callsNamed(entry.scan, 't')].sort(
    (left, right) => left.callStart - right.callStart
  );
}

check(
  'extraction reached every CLI source',
  Object.values(cliScans).every((entry) => entry.scan.code.length > 0),
  Object.values(cliScans)
    .map((entry) => `${entry.id}=${entry.scan.code.length} chars`)
    .join(' ')
);

// --- dictionary slicing: the trap this guard must not fall into -------------
//
// The two tables live in ONE object literal. Reading keys over the whole file
// yields their UNION, which makes every assertion below vacuous: a key present
// in `zh` alone would "resolve". The markers are asserted to exist and to be
// ordered, so a structural edit to the dictionary fails loudly rather than
// shrinking the scan to nothing.

const ZH_MARKER = '\n  zh: {';
const EN_MARKER = '\n  en: {';
const TABLE_END = '\n};';

/**
 * Slice one language table out of `language.ts` and read every entry.
 *
 * Line-oriented and FAIL-CLOSED: a non-empty line inside the block that is not
 * a `'key': 'value',` entry is collected as `unparsed` and fails the caller,
 * because a format change that quietly skipped lines would silently shrink the
 * key set — and a shrunken key set makes check B pass.
 */
function sliceTable(source, language) {
  const zhAt = source.indexOf(ZH_MARKER);
  const enAt = source.indexOf(EN_MARKER);
  if (zhAt === -1 || enAt === -1) return { error: 'could not locate the zh:/en: table markers' };
  if (zhAt >= enAt) return { error: 'the zh: table does not precede the en: table' };
  const endAt = source.indexOf(TABLE_END, enAt);
  if (endAt === -1) return { error: `could not locate the table end ${JSON.stringify(TABLE_END)}` };

  const start = (language === 'zh' ? zhAt + ZH_MARKER.length : enAt + EN_MARKER.length);
  const stop = language === 'zh' ? enAt : endAt;
  const block = source.slice(start, stop);
  const startLine = source.slice(0, start).split('\n').length;

  const entries = [];
  const duplicates = [];
  const unparsed = [];
  const seen = new Set();

  block.split('\n').forEach((line, offset) => {
    const lineNumber = startLine + offset;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed === ',' || trimmed === '}' || trimmed === '},') return;
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return;
    const match = /^'((?:[^'\\]|\\.)*)'\s*:\s*'(?:[^'\\]|\\.)*'\s*,?$/.exec(trimmed);
    if (!match) {
      unparsed.push({ line: lineNumber, text: trimmed });
      return;
    }
    const key = match[1];
    if (seen.has(key)) duplicates.push({ key, line: lineNumber });
    seen.add(key);
    entries.push({ key, line: lineNumber });
  });

  return { entries, duplicates, unparsed, lines: block.split('\n').length, startLine };
}

const zhTable = sliceTable(languageSource, 'zh');
const enTable = sliceTable(languageSource, 'en');

for (const [language, table] of [['zh', zhTable], ['en', enTable]]) {
  check(
    `the ${language}: table was sliced out of the dictionary`,
    !table.error && table.entries.length > 0,
    table.error ?? `${table.entries.length} entries over ${table.lines} lines (starting line ${table.startLine})`
  );
  check(
    `every line inside the ${language}: table parsed as a dictionary entry`,
    !table.error && table.unparsed.length === 0,
    table.error ?? (table.unparsed.length === 0 ? 'clean' : table.unparsed.map((entry) => `line ${entry.line}: ${entry.text}`).join(' | '))
  );
  check(
    `no duplicate key inside the ${language}: table`,
    !table.error && table.duplicates.length === 0,
    table.error ?? (table.duplicates.length === 0 ? 'clean' : table.duplicates.map((entry) => `${entry.key} (line ${entry.line})`).join(' | '))
  );
}

/** Minimum entry count of each dictionary table (measured 91, floor 25% below). */
const TABLE_FLOOR = 68;
/**
 * The floor that makes a sliced read non-vacuous.
 *
 * The lines of one table are a subset of the file, so `lines` here is the
 * guard against a marker edit that slices an empty region: an empty region
 * parses as zero entries, which every parity assertion would happily accept.
 */
const TABLE_LINE_FLOOR = 70;

for (const [language, table] of [['zh', zhTable], ['en', enTable]]) {
  check(
    `the ${language}: table slice is not vacuous`,
    !table.error && table.entries.length > TABLE_FLOOR && table.lines > TABLE_LINE_FLOOR,
    table.error ?? `${table.entries.length} entries (floor > ${TABLE_FLOOR}) over ${table.lines} lines (floor > ${TABLE_LINE_FLOOR})`
  );
}

const zhKeys = new Set((zhTable.entries ?? []).map((entry) => entry.key));
const enKeys = new Set((enTable.entries ?? []).map((entry) => entry.key));

// Proof that the slice is a slice and not a whole-file scan: the two tables hold
// the same NUMBER of keys, but the union must still be readable, and a
// whole-file key scan is what the marker-based slice replaces. Asserted by
// construction rather than by a comment — if the markers were ever dropped and
// both tables were read from the same span, the two sets would be identical
// objects rather than independently sliced ones, and the parity check below
// would be checking a set against itself.
check(
  'the two tables were sliced independently, not read as one union',
  zhTable.startLine !== enTable.startLine && zhTable.lines > 0 && enTable.lines > 0,
  `zh: starts line ${zhTable.startLine} (${zhTable.lines} lines), en: starts line ${enTable.startLine} (${enTable.lines} lines)`
);

// --- CHECK A: every tr() key literal resolves in BOTH tables ----------------

/** A dictionary key: dot-separated segments. */
const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/;

/** The static prefix of a template literal used as a key, up to its first `${`. */
function templateKeyPrefix(raw) {
  const body = raw.slice(1, -1);
  const at = body.indexOf('${');
  return at === -1 ? body : body.slice(0, at);
}

/**
 * The statically-resolvable key literals in `entry`, plus the set that had to be
 * skipped and WHY.
 *
 * The window is the call's whole argument span, not a `tr('…')` regex, because
 * a key can reach `t()` through a fallback (`tr(map[x] ?? 'cli.…Unknown')`).
 * Measured on the real tree: the window form finds 4 keys the regex form misses,
 * and those four are exactly the `??` fallbacks — the keys a renamed word map
 * breaks first.
 */
function translateKeySites(entry) {
  const sites = [];
  const excluded = [];
  for (const call of entry.translateCalls) {
    for (const template of templatesWithin(entry.scan, call.start, call.stop)) {
      excluded.push({
        file: entry.label,
        line: template.line,
        text: template.raw,
        reason: `template literal (dynamic key, prefix ${JSON.stringify(templateKeyPrefix(template.raw))})`
      });
    }
    for (const literal of stringsWithin(entry.scan, call.start, call.stop)) {
      if (KEY_SHAPE.test(literal.value)) {
        sites.push({ key: literal.value, line: literal.line, file: entry.label });
      } else {
        excluded.push({ file: entry.label, line: literal.line, text: literal.raw, reason: 'not a segment.segment key' });
      }
    }
  }
  return { sites, excluded };
}

const keySites = [];
const excludedKeySites = [];
for (const entry of Object.values(cliScans)) {
  const { sites, excluded } = translateKeySites(entry);
  keySites.push(...sites);
  excludedKeySites.push(...excluded);
}

/** Minimum statically-resolvable CLI keys (measured 74, floor 26% below). */
const CLI_KEY_FLOOR = 55;
/** Minimum keys in the bin entry point (measured 1 — its only dictionary reach). */
const BIN_KEY_FLOOR = 1;

const cliKeyCount = new Set(keySites.filter((site) => site.file.endsWith('index.ts')).map((site) => site.key)).size;
const binKeyCount = new Set(keySites.filter((site) => !site.file.endsWith('index.ts')).map((site) => site.key)).size;

check(
  'the CLI key extraction found real content',
  cliKeyCount > CLI_KEY_FLOOR,
  `packages/cli/src/index.ts: ${cliKeyCount} distinct keys (floor > ${CLI_KEY_FLOOR})`
);
check(
  'the bin key extraction found the entry point\'s dictionary reach',
  binKeyCount >= BIN_KEY_FLOOR,
  `packages/cli/bin/myagent.js: ${binKeyCount} distinct keys (floor >= ${BIN_KEY_FLOOR})`
);
check(
  'the CLI translate-call extraction matched real call sites',
  Object.values(cliScans).every((entry) => entry.translateCalls.length > 0),
  Object.values(cliScans).map((entry) => `${entry.id}=${entry.translateCalls.length} calls`).join(' ')
);

const unresolvedSites = keySites.filter((site) => !zhKeys.has(site.key) || !enKeys.has(site.key));
const unresolvedLabels = [...new Set(unresolvedSites.map((site) => {
  const missing = [];
  if (!zhKeys.has(site.key)) missing.push('zh');
  if (!enKeys.has(site.key)) missing.push('en');
  return `${site.file}:${site.line}  ${site.key}  (missing from ${missing.join(' + ')})`;
}))].sort();

check(
  'every tr() key literal in the CLI resolves in BOTH tables',
  unresolvedLabels.length === 0,
  unresolvedLabels.length === 0
    ? `${new Set(keySites.map((site) => site.key)).size} distinct keys resolved across ${keySites.length} call sites`
    : unresolvedLabels.join('\n      ')
);

// The skipped set is PRINTED, never dropped. A silent exclusion is how a key
// extraction stops covering the code it claims to cover.
const excludedLabels = [...new Set(excludedKeySites.map((site) => `${site.file}:${site.line}  ${site.text}  (${site.reason})`))].sort();
info(
  'tr() literals excluded from the exact key resolution',
  excludedLabels.length === 0 ? 'none' : `${excludedLabels.length} sites: ${excludedLabels.join(' | ')}`
);

// --- CHECK B: the two tables agree ------------------------------------------

const zhOnly = [...zhKeys].filter((key) => !enKeys.has(key)).sort();
const enOnly = [...enKeys].filter((key) => !zhKeys.has(key)).sort();

check(
  'no key is defined in the zh: table only',
  zhOnly.length === 0,
  zhOnly.length === 0 ? `${zhKeys.size} keys shared` : zhOnly.join(', ')
);
check(
  'no key is defined in the en: table only',
  enOnly.length === 0,
  enOnly.length === 0 ? `${enKeys.size} keys shared` : enOnly.join(', ')
);

// --- CHECK C: the enum word maps are complete -------------------------------

/**
 * The quoted values of a core union. An `export type X = …;` alias is matched
 * first; otherwise the `X: 'a' | 'b';` property union is read.
 *
 * Returns [] when neither exists, which the caller treats as a vacuous parse and
 * FAILS. Deliberately a local copy of `check-dict-parity.mjs`'s helper rather
 * than an import: that file is a script with no export surface, so importing it
 * would execute it (and double every one of its checks).
 */
function parseUnionValues(source, name) {
  const alias = source.match(new RegExp(`export type ${name}\\s*=([\\s\\S]*?);`));
  if (alias) return [...alias[1].matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((match) => match[1]);
  const inline = new RegExp(`(?:^|[\\s{;])${name}\\??\\s*:([^;]*);`, 'gm');
  for (const match of source.matchAll(inline)) {
    const body = match[1].trim();
    if (!/^(?:'[^']*'|\s*\|\s*)+$/.test(body)) continue;
    const values = [...body.matchAll(/'([^']*)'/g)].map((literal) => literal[1]);
    if (values.length > 0) return values;
  }
  return [];
}

/**
 * The `{ key: 'value', … }` literal of a named `const` in the masked CLI source.
 *
 * An ABSENT declaration and a PRESENT-BUT-EMPTY one are deliberately distinct
 * states, exactly as the parity guard's word-map reader treats them: the first
 * means "the map was never added", the second means "the map exists and maps
 * nothing", and colliding them would let an emptied map masquerade as an
 * unmapped enum.
 */
function readWordMap(scan, mapName) {
  const declaration = scan.code.indexOf(`const ${mapName}`);
  if (declaration === -1) return { error: `word map declaration not found: const ${mapName}` };
  const open = scan.code.indexOf('{', declaration);
  if (open === -1) return { error: `word map ${mapName} has no object literal` };
  // The literal's end is the brace the MASK says closes it, so a `};` inside a
  // string value or a comment cannot truncate the map early and hide entries.
  let depth = 0;
  for (let index = open; index < scan.code.length; index += 1) {
    const ch = scan.code[index];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        // The ENTRY TEXT is read from the raw source, not from `scan.code`: the
        // mask blanks string bodies, and every key this map holds IS a string
        // body. Only the brace offsets come from the mask. An entry whose key
        // position is blanked in the mask sits inside a comment or a string, so
        // it is not an entry — that is the one thing the mask is used for here.
        const rawBlock = scan.source.slice(open + 1, index);
        const entries = [];
        for (const match of rawBlock.matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*:\s*'([^'\\\n]*)'/g)) {
          const keyOffset = open + 1 + match.index + match[0].indexOf(match[1]);
          if (scan.code[keyOffset] === ' ') continue;
          entries.push({ key: match[1], value: match[2], line: scan.lineAt(keyOffset) });
        }
        return { entries, keys: new Set(entries.map((entry) => entry.key)), block: rawBlock };
      }
    }
  }
  return { error: `unterminated object literal for ${mapName}` };
}

const WORD_MAPS = [
  { name: 'riskWordKeys', enumSource: reviewTypesSource, enumFile: 'packages/core/src/review/types.ts', enumName: 'RiskLevel' },
  { name: 'reviewerWordKeys', enumSource: reviewTypesSource, enumFile: 'packages/core/src/review/types.ts', enumName: 'reviewedBy' },
  { name: 'modeWordKeys', enumSource: reviewTypesSource, enumFile: 'packages/core/src/review/types.ts', enumName: 'AutoReviewMode' }
];

const cliScan = cliScans.cli;

for (const map of WORD_MAPS) {
  const read = readWordMap(cliScan.scan, map.name);
  check(
    `${map.name} was found and is not empty`,
    !read.error && read.entries.length > 0,
    read.error ?? `${read.entries.length} entries: ${read.entries.map((entry) => `${entry.key} → ${entry.value}`).join(', ')}`
  );
  if (read.error) continue;

  const unresolved = read.entries.filter((entry) => !zhKeys.has(entry.value) || !enKeys.has(entry.value));
  check(
    `every value key in ${map.name} resolves in both tables`,
    unresolved.length === 0,
    unresolved.length === 0
      ? `${read.entries.length} keys resolved`
      : unresolved
          .map((entry) => {
            const missing = [];
            if (!zhKeys.has(entry.value)) missing.push('zh');
            if (!enKeys.has(entry.value)) missing.push('en');
            return `${entry.key} → ${entry.value} (missing from ${missing.join(' + ')})`;
          })
          .join(' | ')
  );

  const enumValues = parseUnionValues(map.enumSource, map.enumName);
  check(
    `the ${map.enumName} union is statically readable from ${map.enumFile}`,
    enumValues.length > 0,
    enumValues.length > 0 ? `${enumValues.length} values: ${enumValues.join(', ')}` : 'the union could not be parsed — the coverage check below cannot run'
  );

  const missingValues = enumValues.filter((value) => !read.keys.has(value));
  const extraValues = [...read.keys].filter((value) => !enumValues.includes(value));
  check(
    `${map.name} covers every ${map.enumName} value`,
    enumValues.length > 0 && missingValues.length === 0,
    enumValues.length === 0
      ? 'not run: the union is unreadable'
      : missingValues.length === 0
        ? `${enumValues.length}/${enumValues.length} covered${extraValues.length > 0 ? ` (also maps ${extraValues.join(', ')}, which the union does not declare)` : ''}`
        : `not mapped: ${missingValues.join(', ')}`
  );
}

// --- CHECK C, second half: the one dynamic key family ------------------------
//
// A literal scan cannot see `` tr(`status.${x}`) ``: the key does not exist in
// the source as a whole string. The prefix does, so it is enumerated against the
// enum that supplies the values and every member is resolved. An unexpanded
// prefix is a FAIL rather than an INFO, because an unexpanded prefix is exactly
// a hole — the position the two existing guards left open for the CLI.

const AGENT_STATUS = parseUnionValues(coreTypesSource, 'AgentStatus');
check(
  'the AgentStatus union is statically readable from packages/core/src/types.ts',
  AGENT_STATUS.length > 0,
  AGENT_STATUS.length > 0 ? `${AGENT_STATUS.length} values: ${AGENT_STATUS.join(', ')}` : 'the union could not be parsed'
);

/** The dynamic key families this guard knows how to expand, by literal prefix. */
const DYNAMIC_KEY_FAMILIES = [
  {
    prefix: 'status.',
    values: AGENT_STATUS,
    source: 'AgentStatus in packages/core/src/types.ts',
    /** `status.*` is a shared concept with the web dictionary, so the count is pinned too. */
    minValues: 8
  }
];

const dynamicPrefixes = [];
for (const entry of Object.values(cliScans)) {
  for (const call of entry.translateCalls) {
    for (const template of templatesWithin(entry.scan, call.start, call.stop)) {
      dynamicPrefixes.push({ file: entry.label, line: template.line, raw: template.raw, prefix: templateKeyPrefix(template.raw) });
    }
  }
}

for (const family of DYNAMIC_KEY_FAMILIES) {
  const uses = dynamicPrefixes.filter((entry) => entry.prefix === family.prefix);
  check(
    `the ${JSON.stringify(family.prefix)} dynamic family is used by the CLI`,
    uses.length > 0 && family.values.length >= family.minValues,
    uses.length > 0
      ? `${uses.length} use(s): ${uses.map((entry) => `${entry.file}:${entry.line}`).join(', ')}; ${family.values.length} values enumerated from ${family.source}`
      : `no ${JSON.stringify(family.prefix)} template was found — either the family was removed or the extraction broke`
  );
  if (uses.length === 0) continue;

  const expanded = family.values.map((value) => family.prefix + value);
  const missing = expanded.filter((key) => !zhKeys.has(key) || !enKeys.has(key));
  check(
    `every expanded ${JSON.stringify(family.prefix)} key resolves in both tables`,
    missing.length === 0,
    missing.length === 0
      ? `${expanded.length}/${expanded.length} resolved`
      : missing
          .map((key) => {
            const missingFrom = [];
            if (!zhKeys.has(key)) missingFrom.push('zh');
            if (!enKeys.has(key)) missingFrom.push('en');
            return `${key} (missing from ${missingFrom.join(' + ')})`;
          })
          .join(' | ')
  );
}

const uncoveredDynamicPrefixes = dynamicPrefixes
  .map((entry) => entry.prefix)
  .filter((prefix) => !DYNAMIC_KEY_FAMILIES.some((family) => family.prefix === prefix));
check(
  'every dynamic tr() key prefix is expanded by a family',
  uncoveredDynamicPrefixes.length === 0,
  uncoveredDynamicPrefixes.length === 0
    ? dynamicPrefixes.length === 0
      ? 'no dynamic prefixes in the CLI'
      : `${dynamicPrefixes.length} template site(s), all covered`
    : `${[...new Set(uncoveredDynamicPrefixes)].join(', ')} — a literal scan cannot see these keys`
);

// --- CHECK D: newly-hardcoded English in a DISPLAY position -----------------
//
// The baseline, pinned EXACTLY, is the whole design of this check. Every one of
// these nine is a slash command the user TYPES — `/status`, `/help` and the rest
// — printed in the `/help` listing next to a translated description. They are
// command tokens, not copy: translating them would make the listing print a
// command nobody can run. They are pinned rather than rewritten for that reason,
// and the check fails ONLY on a literal outside this set, so the existing corpus
// can never be a noise source. Measured on the real tree: with the baseline in
// place the check reports zero findings.
const BASELINE_DISPLAY_LITERALS = new Set([
  '/clear',
  '/exit',
  '/help',
  '/history',
  '/load',
  '/memory',
  '/new',
  '/sessions',
  '/status'
]);

/**
 * The closed set of non-copy display literals, on top of the baseline.
 *
 * The baseline pins the ACCEPTED CORPUS; this predicate covers the two classes
 * of literal that are not copy at all and that a growing shell will legitimately
 * keep adding. Both are closed, so neither can hide a hardcoded sentence:
 *
 *   * escape/whitespace only — `output.write('\n\n')` is vertical layout;
 *   * unit tokens — ` (${duration}ms)` writes the COLLAPSED literal `"  (ms)"`,
 *     which is a unit, not a word.
 *
 * Naming them here is the same move the web guard makes with its vocabulary
 * sets: extend the closed vocabulary rather than loosen the predicate. Loosening
 * it (say, "ignore literals under N characters") is what would destroy the
 * detection, and a generic prose heuristic would instead fire on the existing
 * corpus forever.
 */
const DISPLAY_UNIT_TOKENS = new Set(['ms', 's', 'm', 'x', 'px', 'kb', 'mb', 'gb', 'hz', 'fps']);

/** A literal that is only escapes and whitespace: layout, not copy. */
function isLayoutOnlyLiteral(value) {
  return value.replace(/\\./g, '').trim() === '';
}

/** A literal that is only a parenthesised unit token: a unit, not copy. */
function isUnitOnlyLiteral(value) {
  const stripped = value
    .replace(/\\./g, '')
    .trim()
    .replace(/^\(+|\)+$/g, '')
    .trim();
  return stripped !== '' && DISPLAY_UNIT_TOKENS.has(stripped.toLowerCase()) && /^[A-Za-z]+$/.test(stripped);
}

/** A display literal that is neither copy nor on the baseline. */
function isNewDisplayCopy(value) {
  if (BASELINE_DISPLAY_LITERALS.has(value)) return false;
  if (isLayoutOnlyLiteral(value)) return false;
  if (isUnitOnlyLiteral(value)) return false;
  return true;
}

/**
 * The display sinks a CLI literal can reach the terminal through.
 *
 * `pc.<color>(…)` is included as its own sink rather than only as a nested call,
 * because `output.write(pc.red('x'))` would otherwise be read through
 * `output.write` alone and a bare `pc.red('x')` statement not at all.
 * `rl.setPrompt` and `iface.question` are sinks too — the prompt and the
 * approval question both reach the screen.
 */
const DISPLAY_SINKS = [
  { pattern: /(?<![\w$.])console\.(?:log|info|warn|error|debug)\s*\(/g, describe: (text) => text.replace(/\s*\($/, '') },
  { pattern: /(?<![\w$.])output\.write\s*\(/g, describe: () => 'output.write' },
  { pattern: /(?<![\w$.])pc\.[A-Za-z]+\s*\(/g, describe: (text) => text.replace(/\s*\($/, '') },
  { pattern: /(?<![\w$.])(?:rl|iface)\.(?:setPrompt|question)\s*\(/g, describe: (text) => text.replace(/\s*\($/, '') },
  { pattern: /(?<![\w$.])process\.stdout\.write\s*\(/g, describe: () => 'process.stdout.write' },
  { pattern: /(?<![\w$.])process\.stderr\.write\s*\(/g, describe: () => 'process.stderr.write' }
];

/**
 * Literals reaching a display sink that are NOT arguments of a `tr()` / `t()`
 * call. Each finding carries the sink and the line so the reader can go straight
 * to it; findings are deduplicated by value so one literal nested through
 * `console.log(pc.red('x'))` is reported once.
 */
function displayLiterals(entry) {
  const translateSpans = [
    ...callsNamed(entry.scan, 'tr').map((call) => ({ start: call.start, stop: call.stop })),
    ...callsNamed(entry.scan, 't').map((call) => ({ start: call.start, stop: call.stop }))
  ];
  const sinks = DISPLAY_SINKS.flatMap((sink) => callsMatching(entry.scan, sink.pattern, sink.describe));
  const insideTranslate = (at) => translateSpans.some((span) => at >= span.start && at < span.stop);

  const found = new Map();
  for (const sink of sinks) {
    for (const literal of stringsWithin(entry.scan, sink.start, sink.stop)) {
      if (insideTranslate(literal.start)) continue;
      if (!/[A-Za-z]/.test(literal.value)) continue;
      const key = literal.value;
      if (!found.has(key)) {
        found.set(key, { value: literal.value, file: entry.label, line: literal.line, sink: sink.name });
      }
    }
    for (const template of templatesWithin(entry.scan, sink.start, sink.stop)) {
      if (insideTranslate(template.start)) continue;
      const staticText = staticTemplateText(template.raw);
      if (!/[A-Za-z]/.test(staticText)) continue;
      const key = `template:${staticText}`;
      if (!found.has(key)) {
        found.set(key, { value: staticText, file: entry.label, line: template.line, sink: sink.name });
      }
    }
  }
  return { findings: [...found.values()], sinkCount: sinks.length };
}

/** Minimum display-sink call sites (measured 56, floor 25% below). */
const DISPLAY_SINK_FLOOR = 42;

const displayResults = Object.values(cliScans).map((entry) => ({ label: entry.label, ...displayLiterals(entry) }));
const totalSinkCount = displayResults.reduce((sum, result) => sum + result.sinkCount, 0);

check(
  'the display-sink extraction found real call sites',
  totalSinkCount > DISPLAY_SINK_FLOOR,
  `${totalSinkCount} sink calls (floor > ${DISPLAY_SINK_FLOOR}) — ${displayResults.map((result) => `${result.label}=${result.sinkCount}`).join(', ')}`
);

const allDisplayFindings = displayResults.flatMap((result) => result.findings);
const newDisplayFindings = allDisplayFindings.filter((finding) => isNewDisplayCopy(finding.value));

check(
  'no NEW hardcoded English literal reaches a CLI display sink',
  newDisplayFindings.length === 0,
  newDisplayFindings.length === 0
    ? `${allDisplayFindings.length} literal(s) found, all on the pinned baseline of ${BASELINE_DISPLAY_LITERALS.size} or in a closed non-copy class`
    : newDisplayFindings.map((finding) => `${finding.file}:${finding.line}  ${JSON.stringify(finding.value)}  (${finding.sink})`).join('\n      ')
);

const baselineStillSeen = [...BASELINE_DISPLAY_LITERALS].filter((value) => allDisplayFindings.some((finding) => finding.value === value));
info(
  'pinned display-literal baseline',
  `${baselineStillSeen.length}/${BASELINE_DISPLAY_LITERALS.size} still present in a display sink` +
    (baselineStillSeen.length === BASELINE_DISPLAY_LITERALS.size
      ? ''
      : ` — no longer found: ${[...BASELINE_DISPLAY_LITERALS].filter((value) => !baselineStillSeen.includes(value)).join(', ')}`)
);

// --- self-test: the detectors must be able to fail --------------------------
//
// Each detector is re-run against a synthetic source carrying a KNOWN defect.
// A control that cannot fail proves nothing, so every assertion below plants the
// defect the check exists for and requires the SAME code path the real check
// runs to report it. The real extractions are asserted against the live tree in
// the same block, so a floor cannot drift apart from what it measures.

{
  // (A) A nonexistent key must be reported, naming it and the missing tables.
  //
  // The "does resolve" witness is taken from the LIVE table rather than written
  // as a key name. A hardcoded witness (`cli.banner`) turns an unrelated table
  // edit into a second, misleading failure from this self-test; a derived one
  // stays a true control for as long as the table is non-empty, which the floor
  // above already asserts.
  const RESOLVING_WITNESS = [...zhKeys].filter((key) => enKeys.has(key)).sort()[0];
  const missingKeyScan = scanSource(`const a = tr('cli.zzzMissing');\nconst b = tr('${RESOLVING_WITNESS}');\n`);
  const missingKeyEntry = { label: 'synthetic.ts', scan: missingKeyScan, translateCalls: callsNamed(missingKeyScan, 'tr') };
  const missingKeySites = translateKeySites(missingKeyEntry).sites;
  const missingKeyHits = missingKeySites.filter((site) => !zhKeys.has(site.key) || !enKeys.has(site.key));
  check(
    'self-test: a nonexistent tr() key is detected',
    missingKeyHits.length === 1 && missingKeyHits[0].key === 'cli.zzzMissing',
    missingKeyHits.map((site) => `${site.file}:${site.line} ${site.key}`).join(' | ') || 'no hit'
  );
  check(
    'self-test: a key that DOES resolve is not reported',
    missingKeySites.length === 2 && missingKeyHits.length === 1,
    `${missingKeySites.length} sites extracted (witness ${JSON.stringify(RESOLVING_WITNESS)}), ${missingKeyHits.length} unresolved`
  );

  // The window, not a regex: a key reached through a `??` fallback must be
  // extracted. This is the class the regex form measured 4 misses on.
  const fallbackScan = scanSource("const key = tr(map[level] ?? 'cli.approval.riskUnknown');\n");
  const fallbackEntry = { label: 'synthetic.ts', scan: fallbackScan, translateCalls: callsNamed(fallbackScan, 'tr') };
  check(
    'self-test: a key reached through a `??` fallback is extracted from the call window',
    translateKeySites(fallbackEntry).sites.map((site) => site.key).join(',') === 'cli.approval.riskUnknown',
    translateKeySites(fallbackEntry).sites.map((site) => site.key).join(',') || 'no hit'
  );

  // A template literal cannot be resolved, so it must be EXCLUDED and PRINTED —
  // never silently dropped, and never read as the prefix-shaped key it resembles.
  const templateScan = scanSource('const key = tr(`status.${state}`);\n');
  const templateEntry = { label: 'synthetic.ts', scan: templateScan, translateCalls: callsNamed(templateScan, 'tr') };
  const templateSites = translateKeySites(templateEntry);
  check(
    'self-test: a template-literal key is excluded from resolution and reported as excluded',
    templateSites.sites.length === 0 && templateSites.excluded.length === 1 && templateSites.excluded[0].reason.includes('status.'),
    `${templateSites.sites.length} resolved, ${templateSites.excluded.length} excluded: ${templateSites.excluded.map((site) => site.reason).join(' | ')}`
  );

  // A `tr(` inside a comment or inside a string body must NOT be read as a call.
  // Without the mask these are the two ways a literal scan finds phantom keys.
  const decoyScan = scanSource("// tr('cli.commentDecoy')\nconst s = \"say tr('cli.stringDecoy')\";\nconst real = tr('cli.banner');\n");
  check(
    'self-test: tr( inside a comment or a string body is not read as a call',
    callsNamed(decoyScan, 'tr').length === 1,
    `${callsNamed(decoyScan, 'tr').length} call(s) found (expected 1)`
  );

  // (B) An asymmetry must be reported, in BOTH directions.
  const ASYMMETRIC_FIXTURE = "const DICTS = {\n  zh: {\n    'a.one': 'x',\n    'a.two': 'y',\n  },\n  en: {\n    'a.one': 'x',\n  },\n};\n";
  const asymmetricZh = sliceTable(ASYMMETRIC_FIXTURE, 'zh');
  const asymmetricEn = sliceTable(ASYMMETRIC_FIXTURE, 'en');
  const syntheticZhKeys = new Set(asymmetricZh.entries.map((entry) => entry.key));
  const syntheticEnKeys = new Set(asymmetricEn.entries.map((entry) => entry.key));
  const zhOnlySynthetic = [...syntheticZhKeys].filter((key) => !syntheticEnKeys.has(key));
  check(
    'self-test: a one-sided table is detected in both directions',
    zhOnlySynthetic.join(',') === 'a.two' && [...syntheticEnKeys].filter((key) => !syntheticZhKeys.has(key)).length === 0 &&
      [...new Set(['a.one', 'a.two'])].filter((key) => !syntheticEnKeys.has(key)).join(',') === 'a.two',
    `zh=${asymmetricZh.entries.length} en=${asymmetricEn.entries.length}, zh-only=[${zhOnlySynthetic.join(', ')}], en-only=[]`
  );
  const reversedFixture = "const DICTS = {\n  zh: {\n    'a.one': 'x',\n  },\n  en: {\n    'a.one': 'x',\n    'a.two': 'y',\n  },\n};\n";
  const reversedZhKeys = new Set(sliceTable(reversedFixture, 'zh').entries.map((entry) => entry.key));
  const reversedEnKeys = new Set(sliceTable(reversedFixture, 'en').entries.map((entry) => entry.key));
  check(
    'self-test: an en-only key is detected too (the asymmetry is not one-directional)',
    [...reversedEnKeys].filter((key) => !reversedZhKeys.has(key)).join(',') === 'a.two' &&
      [...reversedZhKeys].filter((key) => !reversedEnKeys.has(key)).length === 0,
    `en-only=[${[...reversedEnKeys].filter((key) => !reversedZhKeys.has(key)).join(', ')}], zh-only=[]`
  );
  const duplicateTable = sliceTable("const DICTS = {\n  zh: {\n    'a.one': 'x',\n    'a.one': 'y',\n  },\n  en: {\n    'a.one': 'x',\n  },\n};\n", 'zh');
  check(
    'self-test: a duplicate key inside one table is detected',
    duplicateTable.duplicates.length === 1 && duplicateTable.duplicates[0].key === 'a.one',
    duplicateTable.duplicates.map((entry) => `${entry.key} (line ${entry.line})`).join(' | ') || 'no hit'
  );
  const unparsedTable = sliceTable("const DICTS = {\n  zh: {\n    'a.one': compute(),\n  },\n  en: {\n    'a.one': 'x',\n  },\n};\n", 'zh');
  check(
    'self-test: a non-entry line inside a table is detected rather than skipped',
    unparsedTable.unparsed.length === 1,
    unparsedTable.unparsed.map((entry) => entry.text).join(' | ') || 'no hit'
  );
  check(
    'self-test: the slice markers are required, so a renamed table fails loudly',
    Boolean(sliceTable("const DICTS = { zh: {}, en: {} };\n", 'zh').error),
    sliceTable("const DICTS = { zh: {}, en: {} };\n", 'zh').error ?? 'no error reported'
  );
  // The whole-file trap, exercised rather than asserted in a comment: reading
  // keys across the file yields the union, which contains the zh-only key and
  // therefore makes the parity check vacuous. The slice must NOT contain it in en.
  const wholeFileKeys = new Set([...ASYMMETRIC_FIXTURE.matchAll(/'([^']+)'\s*:/g)].map((match) => match[1]));
  check(
    'self-test: a whole-file key scan would be vacuous where the slice is not',
    wholeFileKeys.has('a.two') && !syntheticEnKeys.has('a.two') && syntheticZhKeys.has('a.two'),
    `whole-file scan sees ${wholeFileKeys.size} keys including a.two; the en slice holds ${syntheticEnKeys.size} and does NOT`
  );

  // (C) The word-map reader must distinguish absent, empty and present.
  const syntheticScan = scanSource("const mapKeys: Record<string, string> = {\n  rule: 'cli.a',\n  model: 'cli.b',\n};\n");
  const readMap = readWordMap(syntheticScan, 'mapKeys');
  check(
    'self-test: a word map is parsed with its key/value pairs',
    !readMap.error && [...readMap.keys].join(',') === 'rule,model',
    readMap.error ?? [...(readMap.keys ?? [])].join(',')
  );
  check(
    'self-test: an absent word map is an error, not an empty map',
    Boolean(readWordMap(syntheticScan, 'missingMap').error),
    readWordMap(syntheticScan, 'missingMap').error ?? 'no error reported'
  );
  check(
    'self-test: an empty word map reads as zero keys rather than as absent',
    !readWordMap(scanSource('const mapKeys: Record<string, string> = {};\n'), 'mapKeys').error &&
      readWordMap(scanSource('const mapKeys: Record<string, string> = {};\n'), 'mapKeys').keys.size === 0,
    'empty map resolved with 0 keys and no error'
  );
  // Enum coverage, both directions: a value the map omits is reported, and the
  // workaround of emptying the map cannot read as "the enum has no values".
  const partialMap = readWordMap(scanSource("const mapKeys = { rule: 'cli.a' };\n"), 'mapKeys');
  const syntheticUnion = parseUnionValues("export type Mode = 'rule' | 'model';\n", 'Mode');
  check(
    'self-test: a word map missing an enum value is detected',
    syntheticUnion.length === 2 && syntheticUnion.filter((value) => !partialMap.keys.has(value)).join(',') === 'model',
    `union=${syntheticUnion.join(',')} mapped=${[...partialMap.keys].join(',')} missing=${syntheticUnion.filter((value) => !partialMap.keys.has(value)).join(',') || 'none'}`
  );
  check(
    'self-test: a union that is not statically readable is not treated as empty coverage',
    parseUnionValues('interface R { reviewedBy: value; }\n', 'reviewedBy').length === 0 &&
      parseUnionValues('export type RiskLevel = X;\n', 'RiskLevel').length === 0,
    'both unreadable forms returned no values'
  );
  check(
    'self-test: the three REAL word maps resolve every key they map to',
    WORD_MAPS.every((map) => {
      const read = readWordMap(cliScan.scan, map.name);
      return !read.error && read.entries.length > 0 && read.entries.every((entry) => zhKeys.has(entry.value) && enKeys.has(entry.value));
    }),
    WORD_MAPS.map((map) => `${map.name}=${readWordMap(cliScan.scan, map.name).entries?.length ?? 0}`).join(' ')
  );

  // (D) A raw English literal in a display position must be reported, and the
  // pinned baseline must be what exempts the pre-existing corpus — not a
  // heuristic that would also exempt the plant.
  const displayDefect = displayLiterals({
    label: 'synthetic.ts',
    scan: scanSource("console.log('Hardcoded English output here');\nconsole.log(tr('cli.banner'));\npc.dim(`  ${tr('cli.hint')}`);\n")
  });
  check(
    'self-test: a raw English display literal is detected',
    displayDefect.findings.length === 1 && displayDefect.findings[0].value === 'Hardcoded English output here',
    displayDefect.findings.map((finding) => `${finding.sink}:${JSON.stringify(finding.value)}`).join(' | ') || 'no hit'
  );
  check(
    'self-test: a literal inside tr() and a template of only interpolations are not reported',
    !displayDefect.findings.some((finding) => /cli\.banner/.test(finding.value)) && !displayDefect.findings.some((finding) => /cli\.hint/.test(finding.value)),
    'tr() argument and interpolation-only template both ignored'
  );
  const baselineDefect = displayLiterals({
    label: 'synthetic.ts',
    scan: scanSource("console.log(`  ${pc.cyan('/status')}  - ${tr('cli.help.status')}`);\n")
  });
  check(
    'self-test: a pinned baseline literal is exempted, so the existing corpus cannot fail the check',
    baselineDefect.findings.length === 1 &&
      BASELINE_DISPLAY_LITERALS.has(baselineDefect.findings[0].value) &&
      baselineDefect.findings.filter((finding) => !BASELINE_DISPLAY_LITERALS.has(finding.value)).length === 0,
    `found ${baselineDefect.findings.map((finding) => JSON.stringify(finding.value)).join(', ') || 'nothing'}; 0 outside the baseline`
  );
  check(
    'self-test: pc.<color>(…) is read as a display sink in its own right',
    displayLiterals({ label: 'synthetic.ts', scan: scanSource("pc.red('Standalone colored English');\n") }).findings.length === 1,
    'a bare pc.red(...) statement is reported'
  );
  // `process.stdout.write` / `process.stderr.write` reach the terminal just as
  // `console.log` does, so the two sinks added beside it must report a bare
  // hardcoded write and ignore a tr() argument — the same two-sided control.
  const streamDefect = displayLiterals({
    label: 'synthetic.ts',
    scan: scanSource(
      "process.stdout.write('Hardcoded English here');\nprocess.stdout.write(tr('cli.foo'));\nprocess.stderr.write('Hardcoded English on stderr');\n"
    )
  });
  check(
    'self-test: process.stdout.write / process.stderr.write are display sinks (hardcoded reported, tr() not)',
    streamDefect.findings.length === 2 &&
      streamDefect.findings.map((finding) => `${finding.sink}:${finding.value}`).sort().join(' | ') ===
        'process.stderr.write:Hardcoded English on stderr | process.stdout.write:Hardcoded English here' &&
      !streamDefect.findings.some((finding) => /cli\.foo/.test(finding.value)),
    streamDefect.findings.map((finding) => `${finding.sink}:${JSON.stringify(finding.value)}`).join(' | ') || 'no hit'
  );

  // Extraction sanity, mirroring the two existing guards: the mask must keep
  // braces balanced or every window below it is wrong, and the real CLI must
  // measure what the floors above claim.
  const balance = (source) => {
    let depth = 0;
    for (const ch of source) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    return depth;
  };
  check(
    'self-test: the code mask leaves braces balanced (a `${ }` must not unbalance a body)',
    balance(scanSource('const a = `x ${ { k: 1 } } y`;\n').code) === 0 &&
      balance(scanSource("const a = '}';\nconst b = 1;\n").code) === 0,
    'template interpolation and a brace inside a string both balance'
  );
  check(
    'self-test: the mask strips the static parts of a template but keeps its interpolation as code',
    /tr/.test(scanSource('const a = `text ${tr(0)}`;\n').code) &&
      !/text/.test(scanSource('const a = `text ${tr(0)}`;\n').code) &&
      !/unterminated/.test(scanSource("const a = 'unterminated\nconst b = 1;\n").code),
    'interpolation code preserved, static text and an unterminated string both blanked'
  );
  check(
    'self-test: the real CLI sources are measured where the floors claim they are',
    cliKeyCount > CLI_KEY_FLOOR && totalSinkCount > DISPLAY_SINK_FLOOR && zhTable.entries.length > TABLE_FLOOR,
    `keys=${cliKeyCount} sinks=${totalSinkCount} zh entries=${zhTable.entries.length}`
  );
}

console.log(failures === 0 ? '\nCLI localization guard passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
