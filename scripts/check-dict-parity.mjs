/**
 * Cross-dictionary parity guard for the "单核双驱" (one core, two shells)
 * convention, documented in
 * `.wiki/skills/wiki-architecture-one-core-two-shells/SKILL.md` §9.1:
 *
 *   "三张字典表（web i18n.js / 桌面 menu.ts 的 MENU_LABELS / CLI language.ts 的
 *    DICTS）因运行环境隔离而各存一份，但共享概念的 key 名与措辞必须逐字一致
 *    （如 8 个 status.*），这是「单核双驱」措辞一致约定的落点。"
 *
 * The convention was documented but UNENFORCED. `scripts/check-ui-i18n.mjs`
 * reads only the web shell, so a value mangled in the CLI table left it green —
 * which is the gap this script closes. Both scripts stay: the house guard owns
 * "is the web shell localised at all", this one owns "do the shells still agree
 * on the concepts they share".
 *
 * Relation to `check-ui-i18n.mjs`: that script checks the web shell in
 * isolation; this one checks it against its siblings.
 *
 * Run: node scripts/check-dict-parity.mjs
 * Exit 0 = every shared concept still agrees, or its divergence is a recorded
 *          exception with a reason; 1 = a new divergence, a missing key, a
 *          duplicate key, or a vacuous scan.
 *
 * ── The two check classes in this file ──────────────────────────────────────
 *   (A) cross-dictionary parity (§1-3): do the three shells still agree on the
 *       concepts they share?
 *   (B) core enum → render-site word map (§5): does every value of a core enum
 *       that a shell interpolates into a user-visible string have a word, or does
 *       the surface print the raw token? §4 already proves the `AgentStatus` union
 *       has a dictionary key per state, but that is a key lookup, not a value
 *       translation: nothing proved that an enum VALUE reaching a surface was
 *       mapped to a word. `packages/cli/src/index.ts` maps `riskLevel` and
 *       `reviewedBy` through word keys (`riskWordKeys` / `reviewerWordKeys`, per
 *       the comment above them) and used to interpolate `AutoReviewMode` raw, so
 *       the `/status` block printed `Review:   gpt-4o-mini (lenient)` — the leak
 *       that motivated this class. That leak is fixed (`modeWordKeys` is the
 *       pinned map below), and every entry's map must now resolve to at least one
 *       key, so a DELETED, RENAMED or EMPTIED map is a hard FAIL. The recorded-gap
 *       mechanism remains but `WORD_MAP_ALLOWLIST` is empty.
 *
 *       The class covers BOTH shells. Until §5b existed it read only the CLI
 *       maps, and the SPA's equivalent render sites — `riskLabel()` and
 *       `reviewerLabel()` in `packages/ui/public/index.html`, each holding a
 *       function-local `const keys = { … }` — were unguarded: deleting the `high`
 *       entry there, renaming its target key to one the web dictionary does not
 *       define, or repointing the CLI map's `high` at another level's word all
 *       left this guard, the house guard and the test suite green. §5b reads those
 *       function-local maps by NAME, asserts each union value is a key of them,
 *       and then asserts the ROUTING is right — every target is a key of its own
 *       dictionary, the web and CLI targets for one enum value are a pair the
 *       shared-concept map already establishes, and no two values share a target.
 *       The pairing check is what catches `riskWordKeys.high` pointing at
 *       `cli.approval.riskLow`: `approval.risk.high` is paired with
 *       `cli.approval.riskHigh` by `SHARED_CONCEPTS` (byte-equal words in both
 *       languages) and with nothing else, so the repointed target has no pairing
 *       and the value is reported.
 *
 * ── Why the extraction is sliced, not scanned ───────────────────────────────
 * Every dictionary file holds BOTH languages side by side in one object. A
 * whole-file regex for `'key': 'value'` therefore returns the UNION of the two
 * tables, which makes a key that exists in only one language structurally
 * invisible — the exact trap the house guard hit. So each table is sliced by
 * its literal prefix (`\n  zh: {` → `\n  en: {` → the object's closing brace)
 * before a single entry is read.
 *
 * The quoting reality is handled too: a web value containing an apostrophe must
 * be double-quoted (`"OpenAI's own endpoint, …"`), so a single-quote-only
 * matcher would silently drop those keys and report them as missing from one
 * language. Values are decoded with a real escape decoder, because the card
 * labels carry `\u3000` padding that changes the byte comparison.
 *
 * ── What this check does NOT cover (so nobody reads a green run as more) ────
 *   - The remaining `status.card.*` members that the audit did not name
 *     (`state`, `session`, `leaf`, `messages`, `valence`, `arousal`,
 *     `fatigue`): measured, their zh wording agrees verbatim, but their en
 *     wording legitimately differs in case (`state:` vs `State:`) because the
 *     web card is a padded monospace column while the CLI block is a capitalised
 *     line header. Asserting en there would force seven allowlist entries nobody
 *     asked for, so they are left out rather than silently tolerated.
 *   - The web-only `status.card.*` members (`effort`, `posture`, `autoReviewOff`,
 *     `noEffort`): these have NO counterpart key in the CLI table at all — the
 *     reasoning-effort and posture indicators are not surfaced in the terminal
 *     `/status` block — so they are not pairable, and nothing is being left out
 *     of a comparison.
 *   - `slash.sessions.desc` vs `cli.help.sessions` (and the CLI-only
 *     `cli.help.*` for `/load`, `/new`, `/memory`, `/help`, `/exit`): the
 *     `/status` and `/clear` descriptions agree and ARE asserted; the `/sessions`
 *     description differs in both languages on the current tree. Not asserted
 *     and not reported: it is deliberately left out of the map above, because
 *     the audit did not sanction allowlisting it.
 *   - Desktop `settings` (`设置…`) vs web `menu.actions.settings` (`设置`): the
 *     ellipsis is a native-menu affordance; same reasoning as above.
 *   - The approval family is enforced only where the map below names a pairing.
 *     The unpaired members, and why:
 *       · the card header, web `approval.title` (`需要审批` / `Approval required`)
 *         vs CLI `cli.approval.title` (`⚠ [需要审批]` / `⚠ [Approval Required]`):
 *         the CLI wraps the same core words in a warning bracket, so the strings
 *         are decorated differently by construction and are not byte-equal.
 *       · the attribution preposition, web `approval.via` (`经由 {name}` /
 *         `via {name}`) vs CLI `cli.approval.by` (`由` / `by`): genuinely
 *         different phrasing — the web string is a template carrying the name,
 *         the CLI one a bare preposition — so there is no byte-equal pairing.
 *       · the CLI-only labels `cli.approval.risk`, `.reason`, `.args`,
 *         `.question`: the terminal approval card prints rows the SPA does not
 *         (the SPA labels the same data through its own components), so these
 *         have NO counterpart key to compare against.
 *       · the web-only controls `approval.approve` / `approval.reject` (the CLI
 *         asks a y/N question instead) and the lifecycle states
 *         `approval.waiting`, `approval.approved`, `approval.rejected`,
 *         `approval.retired`, `approval.retiredNote`: the CLI has no
 *         counterpart key at all.
 *     Nothing is left out of a comparison here — the pairs do not exist.
 *   - A concept that exists in only two of the three shells is only compared
 *     where the map below names it — the point of the map is that a human
 *     decided the pairing exists.
 *   - `packages/core/src/loop/engine.ts` composes a denied-tool message in core
 *     itself: hardcoded English prose around raw enum values
 *     (`[AutoReview Denied] ${review.reason} (Risk: ${review.riskLevel}, …)`).
 *     That string never reaches a CLI word map and is not a dictionary entry, so
 *     neither this guard nor the house guard can see it. It is present in HEAD
 *     (git show HEAD:packages/core/src/loop/engine.ts), not a working-tree
 *     addition, so it is a core-side design question for the core owner and not
 *     a regression either guard may block. §5's scope stops at the render sites
 *     the two shells own: the CLI maps (§5a) and the SPA's function-local maps
 *     (§5b). A shell that invents a NEW render site is not covered until an entry
 *     names it, which is why an entry's `web` block pins the function by name.
 *   - A CONSISTENT SYMMETRIC SWAP is not detectable, and cannot be without ground
 *     truth. If both shells repoint `low` at the HIGH key and `high` at the LOW
 *     key, AND both dictionaries swap the two words, this guard passes — and so
 *     does `check-ui-i18n.mjs`, and so does the runtime. Every axis here is a
 *     statement of AGREEMENT between the shells: §5 asserts each union value has a
 *     key IN its map, §5b's target-existence axis asserts the target is a key of
 *     the shell's own dictionary, its shared-target axis asserts no two values
 *     share a target, and its mis-route axis asserts that `(webTarget, cliTarget)`
 *     is SOME pairing `SHARED_CONCEPTS` records. A swap preserves all four: the
 *     two shells still agree, no target is undefined, no target is shared, and
 *     each pair is still a recorded pairing (just the OTHER level's). The guard's
 *     contract is "the same word for the same value" — it can prove the shells
 *     agree with each other, but not that they agree with the WORLD, because the
 *     only ground truth for "`high` means 高" is the human who wrote the enum.
 *     Closing it would need a second, independent statement of level→word (a
 *     fixture, a spec table, a human review) that is itself not derived from the
 *     dictionaries under test; a table restated in this file would drift from the
 *     dictionaries exactly the way the maps under test do. So the hole is
 *     recorded rather than papered over, and the pairing axis is DERIVED from
 *     `SHARED_CONCEPTS` (not restated as a level→key table here) for that reason.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The four dictionaries, each as one file read. `decl` locates the object;
 * the language tables inside it are sliced by `ZH_MARKER` / `EN_MARKER`.
 * `menu` and `about` are two separate objects in ONE file, which is why the
 * decl marker matters rather than the path.
 */
const DICTIONARIES = [
  { id: 'web', label: 'web', file: 'packages/ui/public/i18n.js', decl: 'const DICT = {', end: '\n};' },
  { id: 'cli', label: 'cli', file: 'packages/cli/src/language.ts', decl: 'const DICTS:', end: '\n};' },
  { id: 'menu', label: 'desktop menu', file: 'packages/desktop/src/menu.ts', decl: 'const MENU_LABELS = {', end: '} as const;' },
  { id: 'about', label: 'desktop about', file: 'packages/desktop/src/menu.ts', decl: 'export const ABOUT_LABELS = {', end: '} as const;' }
];

const ZH_MARKER = '\n  zh: {';
const EN_MARKER = '\n  en: {';
const LANGUAGES = ['zh', 'en'];

/** The core union both shells build their lookup key from, `tr('status.' + state)`. */
const STATUS_TYPE_FILE = 'packages/core/src/types.ts';

// --- the core-enum -> CLI word-map entries (check class B, §5) --------------
//
// §4 proves an `AgentStatus` VALUE has a `status.*` KEY. This proves the other
// half of the same convention: an enum value that the CLI interpolates into a
// user-visible string is translated to a WORD, not printed as a raw token. The
// render sites are the evidence each entry is real:
//
//   - `riskLevel` -> `tr(riskWordKeys[review.riskLevel] …)` and `reviewedBy` ->
//     `tr(reviewerWordKeys[review.reviewedBy] …)`
//     (packages/cli/src/index.ts, the approval-card builder). The comment above
//     those maps promises this translation; this entry makes the promise checkable.
//   - `AutoReviewMode` -> `tr(modeWordKeys[runner.reviewer.mode] ?? 'cli.status.modeUnknown')`
//     (packages/cli/src/index.ts, the `/status` block). It used to interpolate
//     `runner.reviewer.mode` RAW and print `(lenient)`; the map now exists in the
//     working tree, so `map: 'modeWordKeys'` pins the fix rather than merely
//     detecting it.
//
// `union` is parsed with the SAME matchAll-on-a-union technique §4 uses for
// `AgentStatus`: a named `export type X = …;` alias first, then the inline
// property union `field: 'a' | 'b'` that core declares without an alias.
// `map` is the const object in the CLI source that must cover it. An entry whose
// map does not exist, does not parse, or resolves to ZERO keys FAILS: a renamed
// map and an emptied map must not read as "nothing to map".
//
// An entry MAY declare `map: null` instead, which pins no name and instead scores
// every object literal in the file for coverage. See the hazard note at the
// score-every-literal branch in `inspectWordMapEntry` before using it.
//
// An entry MAY also declare `web`, which is the SAME enum's render site in the
// SPA — the shape that made the CLI-only reading of this class a hole. The two
// label helpers in `packages/ui/public/index.html` hold their map in a
// FUNCTION-LOCAL `const keys = { … }` rather than a file-scope `const`:
//
//     function riskLabel(risk) {
//       const keys = {
//         safe: 'approval.risk.safe',
//         …
//       };
//       return tr(keys[risk] ?? 'approval.risk.unknown');
//     }
//
// so `map: 'keys'` alone cannot be resolved — three different functions in that
// file declare a local `keys` — and `web.function` bounds the read to the named
// function's body (see `readFunctionScopedMap`). A web entry is read as its own
// target with id `<id>@web`, so it flows through the same reader, the same
// coverage/gap routing, the same allowlist contract and the same floors; §5b then
// asserts the ROUTING its CLI sibling cannot: that the two shells' targets for one
// enum value are a pairing the shared-concept map already establishes, so
// `riskWordKeys.high -> 'cli.approval.riskLow'` is a FAIL rather than a
// complete-but-wrong mapping.
const ENUM_WORD_MAPS = [
  {
    id: 'RiskLevel',
    union: 'RiskLevel',
    map: 'riskWordKeys',
    file: 'packages/core/src/review/types.ts',
    mapFile: 'packages/cli/src/index.ts',
    render: 'approval card: riskWordKeys[key] -> tr()',
    web: {
      file: 'packages/ui/public/index.html',
      function: 'riskLabel',
      map: 'keys',
      render: "web approval card: tr(keys[risk] ?? 'approval.risk.unknown')"
    }
  },
  {
    id: 'reviewedBy',
    union: 'reviewedBy',
    map: 'reviewerWordKeys',
    file: 'packages/core/src/review/types.ts',
    mapFile: 'packages/cli/src/index.ts',
    render: 'approval card: reviewerWordKeys[key] -> tr()',
    web: {
      file: 'packages/ui/public/index.html',
      function: 'reviewerLabel',
      map: 'keys',
      render: "web approval card: tr(keys[reviewedBy] ?? 'approval.reviewer.unknown')"
    }
  },
  {
    id: 'AutoReviewMode',
    union: 'AutoReviewMode',
    map: 'modeWordKeys',
    file: 'packages/core/src/review/types.ts',
    mapFile: 'packages/cli/src/index.ts',
    render: 'CLI /status: tr(modeWordKeys[runner.reviewer.mode] ?? cli.status.modeUnknown)'
  }
];

/**
 * The render-site maps to read, flattened from `ENUM_WORD_MAPS` so the CLI maps
 * and the SPA's function-local maps travel through ONE reader, one gap router, one
 * allowlist and one set of floors.
 *
 * A web target's id is `<enum id>@web`, which is what keeps its recorded gap
 * distinct from the CLI side's in `WORD_MAP_ALLOWLIST` — the two shells can be
 * unmapped for different values, and one shell's pin must not excuse the other's.
 * `mapLabel` is the name a human reads in a FAIL line: the CLI maps are file-scope
 * so their own name is enough, but the web maps are all called `keys`, so the
 * owning function is part of the label.
 */
function wordMapTargets() {
  const targets = [];
  for (const entry of ENUM_WORD_MAPS) {
    targets.push({
      id: entry.id,
      shell: 'cli',
      union: entry.union,
      file: entry.file,
      mapFile: entry.mapFile,
      map: entry.map,
      mapLabel: entry.map,
      render: entry.render
    });
    if (!entry.web) continue;
    targets.push({
      id: `${entry.id}@web`,
      shell: 'web',
      union: entry.union,
      file: entry.file,
      mapFile: entry.web.file,
      function: entry.web.function,
      map: entry.web.map,
      mapLabel: `${entry.web.map} (in ${entry.web.function}())`,
      render: entry.web.render
    });
  }
  return targets;
}

// --- string literals --------------------------------------------------------

/** The simple escapes, as the JS runtime decodes them. */
const SIMPLE_ESCAPES = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  0: '\0',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '`': '`'
};

/** Decode the escape sequence starting at the backslash `at`. */
function decodeEscape(source, at) {
  const kind = source[at + 1];
  if (kind === 'u') {
    if (source[at + 2] === '{') {
      const close = source.indexOf('}', at + 3);
      return { value: String.fromCodePoint(parseInt(source.slice(at + 3, close), 16)), length: close - at + 1 };
    }
    return { value: String.fromCodePoint(parseInt(source.slice(at + 2, at + 6), 16)), length: 6 };
  }
  if (kind === 'x') return { value: String.fromCodePoint(parseInt(source.slice(at + 2, at + 4), 16)), length: 4 };
  return { value: SIMPLE_ESCAPES[kind] ?? kind, length: 2 };
}

/**
 * Read a quoted literal starting at `at` (which must be the opening quote).
 * Both quote styles are honoured — an en value containing an apostrophe is
 * double-quoted, and matching only single quotes would drop it silently.
 */
function readQuoted(source, at) {
  const quote = source[at];
  let index = at + 1;
  let value = '';
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\\') {
      const decoded = decodeEscape(source, index);
      value += decoded.value;
      index += decoded.length;
      continue;
    }
    if (ch === quote) return { value, end: index + 1 };
    value += ch;
    index += 1;
  }
  throw new Error(`unterminated string literal at offset ${at}`);
}

// --- locating declarations in CODE, not in raw text -------------------------
//
// Every reader below used to locate its target with a plain `indexOf` over raw
// source text (`body.indexOf('const ' + mapName)`, `source.indexOf('const ' +
// mapName)`, `body.lastIndexOf('??')`). That is a silent false-negative factory,
// and each of the three shapes was reproduced against the previous revision with
// EXIT=0 and every count still green:
//
//   1. A DECOY MENTION EARLIER IN THE FILE. `indexOf` also matches inside a
//      string literal or a comment, so a decoy that merely *mentions* the map is
//      read instead of the real declaration. Worse: with the real map DELETED and
//      only the decoy left, the guard reported "declares 5 keys" and "5/5 mapped"
//      for a function whose `keys` is `undefined` at runtime — the card throws.
//      The reader's own docstring claimed to prevent exactly this.
//   2. A PREFIX-NAMED SIBLING. `indexOf('const keys')` also matches
//      `const keysLegacy = { … }`, so a legacy copy declared first is read while
//      the real, mislabeled map is never looked at. The same holds for an
//      early-return branch that declares a correct `const keys` before the real
//      (mislabeled) one — a realistic refactor shape.
//   3. A TRAILING `??` FROM ANOTHER EXPRESSION. `lastIndexOf('??')` over the whole
//      body means an unrelated `?? 'key'` later in the function replaces the render
//      site's real fallback, so the guard asserts a defined decoy while the real
//      fallback is undefined and an unrecognised value prints a raw key.
//
// The remedy is one shared scanner: a mask marking which characters are REAL CODE
// (strings, comments and regex literals masked out), against which every
// declaration, body bound, map access and `??` is located. It reuses `readQuoted`
// for quote handling rather than re-implementing escape decoding.
//
// The scanner cannot be fooled into *reading* a decoy, and — because a mask that
// over-masks would hide real code — its one heuristic (is `/` a regex or a
// division?) is biased so that a misjudgement leaves the text as code, which is
// exactly the previous behaviour, rather than swallowing it.

/** Punctuation after which a `/` opens a REGEX literal rather than divides. */
const REGEX_PRECEDER_PUNCTUATION = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '<', '>', '~']);
/** Keywords after which a `/` opens a regex literal (`return /x/.test(y)`). */
const REGEX_PRECEDER_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await', 'case', 'throw']);

/** `text` with every regex metacharacter escaped, for building a pattern. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The end of the quoted literal opening at `at`, or `at` when this is not a string
 * literal at all.
 *
 * The newline rule is what makes this safe on a file that is not pure JavaScript.
 * `packages/ui/public/index.html` is HTML with inline modules, so an apostrophe in
 * an HTML COMMENT — `it reuses the composer popover's keys …` — is not a string
 * opener. A `'`/`"` string in JS can never contain a raw newline, so a quote that
 * reaches a line end without closing is left as CODE. Without this the apostrophe
 * opened a "string" that ran until the next `'` 9,897 characters later and masked
 * two real `const` declarations and a `function tr(` — over-masking, which hides
 * code and is the one failure direction a mask must never take. Templates (`` ` ``)
 * may span lines, so they keep the plain scan.
 *
 * A literal that never closes at all (end of file) is also left as code, for the
 * same reason: masking the remainder of the file would hide everything after it.
 */
function scanQuotedEnd(source, at) {
  const quote = source[at];
  let index = at + 1;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === quote) return index + 1;
    if (ch === '\n' && quote !== '`') return at;
    index += 1;
  }
  return at;
}

/**
 * The end of the regex literal opening at `at`, or `at` when there is no regex
 * literal there. Returning `at` is the conservative direction: the caller then
 * leaves the text marked as code, which is the pre-existing behaviour, instead of
 * masking code away. A regex literal cannot span a line, so hitting a newline
 * before the closing `/` proves this was a division.
 */
function skipRegexLiteral(source, at) {
  let index = at + 1;
  let inClass = false;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === '\n') return at;
    if (inClass) {
      if (ch === ']') inClass = false;
      index += 1;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      index += 1;
      continue;
    }
    if (ch === '/') {
      index += 1;
      while (index < source.length && /[a-z]/i.test(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  return at;
}

/**
 * A mask over `source` where 1 marks REAL CODE and 0 marks a string literal, a
 * template literal's text, a comment or a regex literal.
 *
 * Templates are handled with a mode stack rather than masked whole: the `${…}`
 * of a template literal holds real code — the CLI's `/status` line renders the
 * mode word from inside one — so masking the entire template would hide the very
 * render site this guard reads.
 */
function codeMask(source) {
  const mask = new Uint8Array(source.length).fill(1);
  const stack = ['code'];
  let index = 0;
  let lastChar = '';
  let lastWord = '';
  while (index < source.length) {
    const mode = stack[stack.length - 1];
    const ch = source[index];
    if (ch === '\\' && mode === 'template') {
      mask.fill(0, index, Math.min(index + 2, source.length));
      index += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = scanQuotedEnd(source, index);
      if (end > index) {
        mask.fill(0, index, Math.min(end, source.length));
        index = end;
        if (mode === 'code') {
          lastChar = ch;
          lastWord = '';
        }
        continue;
      }
      // Not a string literal after all (an apostrophe in HTML text, an unterminated
      // quote): leave it as code and keep walking, so the mask can never swallow a
      // real declaration.
      if (mode === 'code') {
        lastChar = ch;
        lastWord = '';
      }
      index += 1;
      continue;
    }
    if (ch === '`') {
      mask[index] = 0;
      if (mode === 'template') stack.pop();
      else {
        stack.push('template');
        if (mode === 'code') {
          lastChar = '`';
          lastWord = '';
        }
      }
      index += 1;
      continue;
    }
    if (ch === '$' && source[index + 1] === '{' && mode === 'template') {
      // The `${` belongs to the template, not to the code: both characters are
      // masked, and the matching `}` is masked too (see the `templateExpr` case
      // below). Masking only the `{` would leave the pair unbalanced, which is the
      // one thing `findBlockEnd` must never see: it bounds a function body by brace
      // depth, so a `{` masked without its `}` closes the body one brace early and
      // the region read after it is wrong.
      mask[index] = 0;
      mask[index + 1] = 0;
      stack.push('templateExpr');
      index += 2;
      continue;
    }
    if (ch === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index);
      const end = newline === -1 ? source.length : newline;
      mask.fill(0, index, Math.min(end, source.length));
      index = end;
      continue;
    }
    if (ch === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      const end = close === -1 ? source.length : close + 2;
      mask.fill(0, index, Math.min(end, source.length));
      index = end;
      continue;
    }
    if (ch === '/' && mode !== 'template' && (REGEX_PRECEDER_PUNCTUATION.has(lastChar) || REGEX_PRECEDER_WORDS.has(lastWord))) {
      const end = skipRegexLiteral(source, index);
      if (end > index) {
        mask.fill(0, index, Math.min(end, source.length));
        index = end;
        lastChar = '/';
        lastWord = '';
        continue;
      }
    }
    if (mode === 'template') {
      mask[index] = 0;
      index += 1;
      continue;
    }
    if (ch === '{' && mode === 'templateExpr') {
      // A nested object literal inside a `${…}`: its `{` is CODE (the expression
      // holds real code the guard may need to read), but the depth has to be
      // tracked so the matching `}` is not mistaken for the one that closes the
      // `${`.
      stack.push('expr');
      index += 1;
      continue;
    }
    if (ch === '}' && mode === 'templateExpr') {
      // The `}` that closes the `${`: masked, so the `${` and its `}` stay balanced
      // in the code projection.
      mask[index] = 0;
      stack.pop();
      index += 1;
      continue;
    }
    if (ch === '{' && mode === 'expr') {
      stack.push('expr');
      index += 1;
      continue;
    }
    if (ch === '}' && mode === 'expr') {
      stack.pop();
      index += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = index;
      while (end < source.length && /[\w$]/.test(source[end])) end += 1;
      if (mode === 'code') {
        lastWord = source.slice(index, end);
        lastChar = source[end - 1];
      }
      index = end;
      continue;
    }
    if (!/\s/.test(ch) && mode === 'code') {
      lastChar = ch;
      lastWord = '';
    }
    index += 1;
  }
  return mask;
}

/** The 1-based line number `index` falls on. */
function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Every REAL `const <name>` declaration in `[from, to)` — matches inside strings
 * and comments are dropped by the mask, and the name is required to end on a word
 * boundary so `const keys` neither matches `const keysLegacy` nor `const keys2`.
 *
 * Returns them in source order, because "there is more than one" is a case the
 * callers must decide about rather than silently resolve.
 */
function findConstDeclarations(source, name, from, to, mask) {
  const pattern = new RegExp(`(?<![\\w$.])const\\s+${escapeRegExp(name)}(?![\\w$])`, 'g');
  const found = [];
  for (const match of source.slice(from, to).matchAll(pattern)) {
    const at = from + match.index;
    if (!mask[at]) continue;
    found.push({ at, end: from + match.index + match[0].length });
  }
  return found;
}

/**
 * Every REAL `<name>[` map access in `[from, to)`, as `{ at, bracket }` — the index
 * of the name and of its opening bracket.
 *
 * The boundary before the name matters: a bare search for `keys[` also matches
 * inside `riskWordKeys[`, so an unrelated map's render site would be read as this
 * one's. ALL of them are returned, because "the map is read in more than one place"
 * is a case the fallback reader must decide about rather than silently resolve to
 * whichever came first.
 */
function findMapAccesses(source, name, from, to, mask) {
  const pattern = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*\\[`, 'g');
  const found = [];
  for (const match of source.slice(from, to).matchAll(pattern)) {
    const at = from + match.index;
    if (!mask[at]) continue;
    found.push({ at, bracket: from + match.index + match[0].length - 1 });
  }
  return found;
}

/**
 * The index of the object literal `{` that opens the value of the declaration
 * ending at `at` — i.e. the first real `{` after the first real `=` — or -1 when
 * the statement ends first.
 *
 * `=` must not be read out of `===` or `=>`, and the search stops at `;` so a
 * declaration with no literal (a bare `const x;`, or a type-only declaration)
 * reports "no object literal" instead of latching onto the next statement's brace.
 */
function findObjectLiteralOpen(source, at, mask) {
  let equalsAt = -1;
  for (let index = at; index < source.length; index += 1) {
    if (!mask[index]) continue;
    const ch = source[index];
    if (equalsAt === -1) {
      if (ch === ';') return -1;
      if (ch === '=' && source[index + 1] !== '=' && source[index + 1] !== '>') equalsAt = index;
      continue;
    }
    if (ch === '{') return index;
    if (ch === ';') return -1;
  }
  return -1;
}

/**
 * The object literal of a map PINNED BY NAME, located by scanning CODE ONLY in
 * `[from, to)`. Shared by the file-scope CLI maps and the SPA's function-local
 * ones so both shells are read by one locator.
 *
 * ── POLICY for more than one real declaration ───────────────────────────────
 * TWO OR MORE real `const <name>` declarations in the scanned region is an ERROR,
 * never a silent pick. The previous reader took the first match, which is what let
 * a prefix-named sibling or an early-return branch's copy stand in for the real
 * map: both are legitimate refactors that produce a second declaration, and in
 * both the guard then measured the wrong literal while reporting complete
 * coverage. There is no way to tell from the text which declaration the render
 * site reads, so the guard refuses to guess and names every candidate line. The
 * fix at the call site is to make the names distinct (rename the legacy copy, or
 * hoist the branch's map), which restores the pin's meaning.
 *
 * ZERO declarations keeps the previous distinction intact: `missingMessage` is
 * what the caller reports, so "the map was never added" and "the map was emptied"
 * stay separable (the emptied case is one declaration with no keys, which the
 * caller FAILS on separately).
 */
function readPinnedMapLiteral(source, mapName, { from, to, mask, context, missingMessage }) {
  const declarations = findConstDeclarations(source, mapName, from, to, mask);
  if (declarations.length === 0) return { error: missingMessage };
  if (declarations.length > 1) {
    return {
      error:
        `${declarations.length} real \`const ${mapName}\` declarations ${context} ` +
        `(lines ${declarations.map((declaration) => lineNumberAt(source, declaration.at)).join(', ')}) — ` +
        'the map cannot be pinned by name while more than one real declaration exists, and picking one would let a legacy copy or an early-return branch stand in for the map the render site reads; rename the others so exactly one remains'
    };
  }
  const open = findObjectLiteralOpen(source, declarations[0].end, mask);
  if (open === -1) return { error: `no object literal after const ${mapName} ${context}` };
  return readFlatMapLiteral(source, open, context, mask);
}

/**
 * The key named after the `??` that belongs to the map access `<name>[…]` — the
 * render site's fallback, which is what an unrecognised enum value prints.
 *
 * This replaces a `lastIndexOf('??')` over the whole function body, which took
 * whatever `??` came LAST: an unrelated `getLanguage?.() ?? 'status.idle'` further
 * down the function replaced the real fallback, so the guard asserted a defined
 * decoy while the site's actual fallback was undefined and a value from a newer
 * core printed the raw key string.
 *
 * The `??` must be part of the SAME expression as the map access: scanning forward
 * from the access's `[` with bracket depth, a `??` only counts at the depth the
 * access itself sits at, and the scan stops as soon as the access's enclosing
 * expression closes (depth below zero), at a statement's `;`, or at a line break
 * that is not continued by `??`. A `??` whose right side is not a string literal
 * (a chained fallback) is skipped rather than reported.
 *
 * ── POLICY for more than one real access ────────────────────────────────────
 * Every real `<name>[` access in the region is read, and the region is only
 * resolved when they AGREE. A second access with a different `??` (or with none at
 * all) is reported as `ambiguous` and the caller FAILS: an earlier decoy access
 * would otherwise win exactly the way the trailing `??` did, and there is no way to
 * tell from the text which access the render site uses. Agreement is the safe
 * case — if two accesses name the same fallback, asserting that key is correct for
 * both.
 *
 * `{ key: null, accesses: 0 }` means the site never reads the map, which the caller
 * reads as "this site has no fallback" — the same meaning it had before, and never
 * an error. `{ key: null, accesses: n }` means the access(es) exist without a
 * `?? 'key'`, likewise "no fallback" as today.
 */
function readFallbackAfterMapAccess(source, name, { from = 0, to = source.length, mask = codeMask(source) } = {}) {
  const accesses = findMapAccesses(source, name, from, to, mask);
  if (accesses.length === 0) return { key: null, accesses: 0 };
  const keys = accesses.map((access) => fallbackInAccessExpression(source, access, to, mask));
  const distinct = [...new Set(keys)];
  if (distinct.length > 1) {
    return { key: null, accesses: accesses.length, ambiguous: distinct.map((key) => key ?? '<none>') };
  }
  return { key: distinct[0] ?? null, accesses: accesses.length };
}

/**
 * The string literal after the `??` that belongs to ONE map access, or `null` when
 * that access's expression has none. Split out so `readFallbackAfterMapAccess` can
 * compare every access rather than resolving to the first.
 */
function fallbackInAccessExpression(source, access, to, mask) {
  let depth = 1; // the access's own `[`
  let index = access.bracket + 1;
  while (index < to && index < source.length) {
    const ch = source[index];
    if (mask[index]) {
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        if (depth < 0) return null;
      } else if (ch === ';' && depth === 0) {
        return null;
      } else if (ch === '?' && source[index + 1] === '?' && depth === 0) {
        let cursor = index + 2;
        while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
        if (source[cursor] === "'" || source[cursor] === '"') {
          try {
            return readQuoted(source, cursor).value;
          } catch {
            return null;
          }
        }
        index = cursor;
        continue;
      } else if (ch === '\n' && depth === 0) {
        let cursor = index + 1;
        while (cursor < source.length && /[ \t]/.test(source[cursor])) cursor += 1;
        if (!(source[cursor] === '?' && source[cursor + 1] === '?')) return null;
      }
    }
    index += 1;
  }
  return null;
}

// --- table slicing ----------------------------------------------------------

/**
 * Slice one language table out of a dictionary object and read every entry.
 *
 * The slice is the point: scanning the whole object would yield the union of
 * both languages. Every marker is asserted to exist and to be ordered, so a
 * structural edit to a dictionary fails loudly instead of shrinking the scan.
 */
function readTable(source, { decl, end }, language, languageMarkers) {
  const declAt = source.indexOf(decl);
  if (declAt === -1) return { error: `dictionary declaration not found: ${JSON.stringify(decl)}` };
  const zhAt = source.indexOf(ZH_MARKER, declAt);
  const enAt = source.indexOf(EN_MARKER, declAt);
  if (zhAt === -1 || enAt === -1 || zhAt >= enAt) return { error: 'could not locate the zh:/en: tables' };
  const endAt = source.indexOf(end, enAt);
  if (endAt === -1) return { error: `could not locate the table end ${JSON.stringify(end)}` };
  // The slice begins AFTER the marker's opening brace, so the table's own `{`
  // is not mistaken for an entry token, and ends BEFORE the next marker (zh) or
  // the object's closing brace (en).
  const marker = language === 'zh' ? ZH_MARKER : EN_MARKER;
  const start = (language === 'zh' ? zhAt : enAt) + marker.length;
  const stop = language === 'zh' ? enAt : endAt;
  const block = source.slice(start, stop);
  const startLine = source.slice(0, start).split('\n').length;
  try {
    const entries = readEntries(block, startLine);
    const map = new Map(entries.map((entry) => [entry.key, entry.value]));
    const seen = new Set();
    const duplicates = [];
    for (const entry of entries) {
      if (seen.has(entry.key)) duplicates.push(entry);
      seen.add(entry.key);
    }
    return { entries, map, duplicates, lines: block.split('\n').length, startLine };
  } catch (error) {
    return { error: `${languageMarkers} table: ${error.message}` };
  }
}

/**
 * Read every `key: 'value'` entry from a sliced table block.
 *
 * Keys are single- or double-quoted strings (web, cli) or bare identifiers
 * (the desktop objects). Whitespace freely spans newlines, which is what makes
 * a value wrapped onto its own line parse correctly. A `}` ends the block: the
 * slice stops before the table's own closing brace for most files, but the
 * desktop `about` tables close on the same line as their only entry.
 */
function readEntries(block, baseLine) {
  const entries = [];
  const lineAt = (index) => baseLine + (block.slice(0, index).match(/\n/g) || []).length;
  let index = 0;
  while (index < block.length) {
    const ch = block[index];
    if (ch === '}') break;
    if (/\s/.test(ch) || ch === ',') {
      index += 1;
      continue;
    }
    if (ch === '/' && block[index + 1] === '/') {
      const newline = block.indexOf('\n', index);
      index = newline === -1 ? block.length : newline + 1;
      continue;
    }
    if (ch === '/' && block[index + 1] === '*') {
      const close = block.indexOf('*/', index);
      index = close === -1 ? block.length : close + 2;
      continue;
    }

    let key;
    let after;
    if (ch === "'" || ch === '"') {
      const read = readQuoted(block, index);
      key = read.value;
      after = read.end;
    } else {
      const bare = /^[A-Za-z_$][\w$]*/.exec(block.slice(index));
      if (!bare) throw new Error(`unexpected token at line ${lineAt(index)}: ${JSON.stringify(block.slice(index, index + 24))}`);
      key = bare[0];
      after = index + bare[0].length;
    }

    let cursor = after;
    while (cursor < block.length && /\s/.test(block[cursor])) cursor += 1;
    if (block[cursor] !== ':') throw new Error(`expected ":" after key ${JSON.stringify(key)} at line ${lineAt(index)}`);
    cursor += 1;
    while (cursor < block.length && /\s/.test(block[cursor])) cursor += 1;
    if (block[cursor] !== "'" && block[cursor] !== '"') {
      throw new Error(`expected a string literal for ${JSON.stringify(key)} at line ${lineAt(index)}`);
    }
    const value = readQuoted(block, cursor);
    entries.push({ key, value: value.value, line: lineAt(index) });
    index = value.end;
  }
  return entries;
}

/** Build every dictionary's tables from a list of `{ id, source, decl, end }`. */
function buildTables(sources) {
  const tables = {};
  for (const entry of sources) {
    const zh = readTable(entry.source, entry, 'zh', entry.label ?? entry.id);
    const en = readTable(entry.source, entry, 'en', entry.label ?? entry.id);
    tables[entry.id] = { zh, en, label: entry.label ?? entry.id };
  }
  return tables;
}

// --- core enums and the CLI word maps that translate them -------------------
//
// The extraction `AgentStatus` already uses (`matchAll(/'([a-z_]+)'/g)` over the
// alias body) is reused rather than re-invented, and extended by one case it does
// not need: core declares two of the three enums here as an alias
// (`export type RiskLevel = …`) but `reviewedBy` only as an interface property
// (`reviewedBy: 'rule' | 'model';`), so the parse falls back to the inline
// property union. Both branches require quoted literals and reject anything
// else, so `reviewedBy: someIdentifier` (not a union) yields nothing and the
// entry fails its floor instead of being read as a value.

/**
 * The quoted values of a core union. An `export type X = …;` alias is matched
 * first; otherwise the `X: 'a' | 'b';` property union is read. Returns [] when
 * neither exists, which the caller treats as a vacuous parse and FAILS.
 */
function parseUnionValues(source, name) {
  const alias = new RegExp(`export type ${name}\\s*=([\\s\\S]*?);`);
  const aliasMatch = source.match(alias);
  if (aliasMatch) return [...aliasMatch[1].matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((match) => match[1]);
  const inline = new RegExp(`(?:^|[\\s{;])${name}\\??\\s*:([^;]*);`, 'gm');
  for (const match of source.matchAll(inline)) {
    const body = match[1].trim();
    // Only a pure union of quoted literals counts — `reviewedBy: value` is a
    // reference, not a union, and must not be read as one.
    if (!/^(?:'[^']*'|\s*\|\s*)+$/.test(body)) continue;
    const values = [...body.matchAll(/'([^']*)'/g)].map((literal) => literal[1]);
    if (values.length > 0) return values;
  }
  return [];
}

/**
 * The key names of a CLI word map, read with the SAME `readEntries` parser the
 * desktop dictionary objects use: bare identifiers on the left, quoted strings
 * on the right, which is exactly a `Record<string, string>` literal.
 *
 * Two states are deliberately distinct, and the difference is the whole point of
 * pinning a name: an ABSENT declaration returns `{ error }` ("the map was never
 * added"), while a present-but-empty one returns `{ keys: [] }` ("the map exists
 * and maps nothing"). Both end in a FAIL, but only the first is what a
 * `WORD_MAP_ALLOWLIST` entry might have been written for, so colliding them would
 * let an emptied map masquerade as an unmapped enum and be absorbed.
 */
function readWordMap(source, mapName, mask = codeMask(source)) {
  return readPinnedMapLiteral(source, mapName, {
    from: 0,
    to: source.length,
    mask,
    context: 'in the file',
    missingMessage: `word map declaration not found: const ${mapName}`
  });
}

/**
 * Read a flat `{ key: 'value', … }` literal starting at its opening brace.
 *
 * Shared by the file-scope CLI maps (`readWordMap`) and the SPA's function-local
 * maps (`readFunctionScopedMap`) so both shells are read by ONE parser: the two
 * shapes differ in where the literal is found, never in how an entry inside it is
 * decoded.
 *
 * The literal's end is the brace the MASK says closes it, so a `};` inside a
 * string value or a comment cannot truncate the map early and make the remaining
 * entries invisible. An EMPTY literal (`= {}` / `= { }`) is resolved as zero keys
 * rather than searched for a `};` that a `{}` body does not contain — otherwise the
 * scan would latch onto an unrelated closing brace further down the file and report
 * a confusing parse error instead of the real finding: the map exists and maps
 * nothing. The caller FAILS on zero keys.
 */
function readFlatMapLiteral(source, open, context, mask = codeMask(source)) {
  const close = findBlockEnd(source, open, mask);
  if (close === -1) return { error: `unterminated object literal ${context}` };
  const block = source.slice(open + 1, close);
  try {
    const entries = readEntries(block, lineNumberAt(source, open));
    return { keys: entries.map((entry) => entry.key), entries };
  } catch (error) {
    return { error: `${context}: ${error.message}` };
  }
}

/**
 * The closing brace of the block starting at `open` (which must hold a `{`), with
 * every character that is not real code — quoted strings, template literals,
 * comments and regex literals — skipped so a brace inside one cannot unbalance the
 * count.
 *
 * Used to bound a FUNCTION BODY before a function-local map is read: the SPA
 * declares its map as `const keys = { … }` inside `riskLabel()` / `reviewerLabel()`
 * / `notificationPermissionMessage()`, so the name alone is ambiguous — reading
 * from the first `const keys` in the file and stopping at the next `};` would
 * happily return whichever function's literal came first, and a deleted map would
 * then still "parse" as another function's. Returns -1 when the block never
 * closes.
 *
 * `findObjectLiteralOpen` is the matching bound for an OBJECT literal: a flat map
 * has no nested braces, so its `};`-equivalent is found by the same mask-driven
 * scan here.
 */
function findBlockEnd(source, open, mask = codeMask(source)) {
  let depth = 0;
  let index = open;
  while (index < source.length) {
    // Every character that is not real code — a string, a comment, a regex literal
    // — is skipped wholesale by the mask, so a `{`/`}` inside one cannot unbalance
    // the count. Previously the three quote characters were handled here and a
    // regex literal was not: `/}/` was counted as a real brace, so the body ended
    // early and the region read after it was wrong. That could only ever over-report
    // (a false FAIL), never hide a gap, but the mask makes it exact for free.
    if (!mask[index]) {
      index += 1;
      continue;
    }
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

/**
 * A word map declared INSIDE a named function, read by name within that function's
 * body: the SPA's render-site shape.
 *
 *     function riskLabel(risk) {
 *       const keys = { safe: 'approval.risk.safe', … };
 *       return tr(keys[risk] ?? 'approval.risk.unknown');
 *     }
 *
 * Three functions in `packages/ui/public/index.html` declare a local `keys`, so the
 * declaration name pins nothing on its own. The body is what makes the pin real:
 * `function <name>` is located first, the body is bounded by `findBlockEnd`, and
 * only a `const <mapName>` inside those bounds is read. A renamed or deleted
 * function, or a map moved out of it, therefore reports `error` (which the caller
 * FAILS on) instead of silently reading a sibling function's literal — the same
 * distinction `readWordMap` draws between "never added" and "emptied" is preserved.
 */
function readFunctionScopedMap(source, functionName, mapName, mask = codeMask(source)) {
  const decl = new RegExp(`(?:^|[^\\w$.])function\\s+${functionName}\\s*\\(`, 'g');
  let match = null;
  for (const candidate of source.matchAll(decl)) {
    // A `function riskLabel(` inside a string or a comment is not a declaration:
    // the previous reader matched the first occurrence anywhere, so a doc comment
    // that merely names the helper could anchor the body to the wrong place.
    if (mask[candidate.index + candidate[0].indexOf('function')]) {
      match = candidate;
      break;
    }
  }
  if (!match) return { error: `function not found: function ${functionName}()` };
  const bodyOpen = source.indexOf('{', match.index + match[0].length - 1);
  if (bodyOpen === -1) return { error: `no body after function ${functionName}()` };
  const bodyEnd = findBlockEnd(source, bodyOpen, mask);
  if (bodyEnd === -1) return { error: `unterminated body for function ${functionName}()` };
  const context = `in function ${functionName}()`;
  const read = readPinnedMapLiteral(source, mapName, {
    from: bodyOpen + 1,
    to: bodyEnd,
    mask,
    context,
    missingMessage: `word map \`const ${mapName}\` not found inside function ${functionName}() — the render site would print raw tokens or a fallback for every value`
  });
  // The render site's SECOND key string: the fallback after `??`, which is what an
  // unrecognised enum value from a newer core renders. It is a dictionary key like
  // any other, so renaming it to something undefined prints a raw key to the user
  // while every coverage count stays green. Read from the site's own map ACCESS
  // (never hardcoded, and never from an unrelated `??` elsewhere in the body) and
  // returned as `fallbackKey`; absent when the site has no `??` fallback.
  const fallback = readFallbackAfterMapAccess(source, mapName, { from: bodyOpen + 1, to: bodyEnd, mask });
  if (fallback.ambiguous) {
    read.error =
      `${fallback.accesses} real \`${mapName}[…]\` accesses in function ${functionName}() name different fallbacks ` +
      `(${fallback.ambiguous.join(', ')}) — the render site's fallback cannot be pinned while they disagree, and picking one would let a decoy access stand in for the site the guard is reading`;
    return read;
  }
  if (fallback.key) read.fallbackKey = fallback.key;
  return read;
}

/**
 * Every `const X = { … }` object literal in a source file, as key lists.
 *
 * Used only for an entry that declares NO map: the fix for such an enum is a new
 * word map, and pinning its name here would mean the fix has to be guessed before
 * it exists. So instead of naming one, every string-map literal in the file is
 * read and the entry is stale as soon as ANY of them covers the union — which is
 * exactly the "the leak was fixed, drop the entry" signal, without this guard
 * dictating what the fix is called.
 *
 * The declaration is located through the same CODE-ONLY mask as the pinned readers,
 * so a `const keys = { … }` that appears inside a string or a comment is not
 * scored as a covering map — a decoy would otherwise retire a `map: null` entry
 * and report a fix that does not exist.
 */
function readAllWordMaps(source, mask = codeMask(source)) {
  const maps = [];
  const decl = /(?<![\w$.])const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*\{/g;
  for (const match of source.matchAll(decl)) {
    if (!mask[match.index]) continue;
    const open = source.indexOf('{', match.index + match[0].length - 1);
    if (open === -1) continue;
    const close = findBlockEnd(source, open, mask);
    if (close === -1) continue;
    try {
      const entries = readEntries(source.slice(open + 1, close), lineNumberAt(source, open));
      if (entries.length > 0) maps.push({ name: match[1], keys: entries.map((entry) => entry.key) });
    } catch {
      // Not a flat key/value map (a nested or computed literal): not a word map,
      // and an unreadable candidate must not abort the scan for the readable one.
    }
  }
  return maps;
}

/**
 * One entry, measured: which values the union declares, which word keys the map
 * declares, which values the map leaves unmapped, and — for an entry with no
 * declared map — whether some map in the file now covers the union.
 *
 * `missing` is the whole union when nothing covers it, which is what makes an
 * unmapped enum report every value rather than an empty gap.
 */
function inspectWordMapEntry(entry, coreSource, mapSource) {
  const values = parseUnionValues(coreSource, entry.union);
  if (!entry.map) {
    // No map is pinned, so score every literal in the file and keep the one that
    // covers the MOST values — not the first that covers them all. A half-done
    // fix (a map added for one value only) must still be MEASURED as a gap,
    // otherwise it reads as "nothing mapped" and a pinned full-union allowlist
    // absorbs it. With the best candidate chosen, the three real states separate:
    // full coverage -> no gap (PASS + stale allowlist entry), partial coverage ->
    // a gap that no full-union pin can match (FAIL), no map at all -> the whole
    // union (INFO while allowlisted).
    //
    // HAZARD, and why `map: null` needs a rule rather than a hope: with no name
    // pinned, "a map that was emptied" and "a map that was never added" are the
    // identical measurement — both leave `coveringMap: null` and `missing` equal
    // to the whole union. A pinned name separates them (`readWordMap` reports "not
    // found" for one and zero keys for the other); this branch cannot. So an entry
    // using `null` must NOT also have a matching WORD_MAP_ALLOWLIST entry, or the
    // pair silently absorbs the regression: emptying the map would route to INFO
    // and pass. That rule is enforced below (`allowlistedNullMapEntries`)
    // rather than left to a comment, and the adoption test stays `covered > 0` so
    // a half-done fix is still measured as a partial gap, not as nothing mapped.
    const candidates = readAllWordMaps(mapSource).map((candidate) => ({
      name: candidate.name,
      keys: candidate.keys,
      covered: values.filter((value) => candidate.keys.includes(value)).length
    }));
    const best = candidates.sort((a, b) => b.covered - a.covered)[0];
    const covered = best && best.covered > 0 ? best : null;
    return {
      id: entry.id,
      union: entry.union,
      map: null,
      values,
      mapKeys: covered ? covered.keys : [],
      coveringMap: covered ? covered.name : null,
      missing: values.filter((value) => !(covered && covered.keys.includes(value))),
      mapError: null
    };
  }
  // One mask per source file, computed once and shared by every reader below, so
  // "is this character real code" is answered the same way for the declaration, the
  // body bound and the `??` of the render site.
  const mask = codeMask(mapSource);
  const read = entry.function
    ? readFunctionScopedMap(mapSource, entry.function, entry.map, mask)
    : readWordMap(mapSource, entry.map, mask);
  // The CLI side's fallback is read from the same source with the map's INDEXED
  // use as the anchor (`riskWordKeys[review.riskLevel] ?? 'cli.approval.riskUnknown'`),
  // which is the render site rather than the declaration. Scoped to the access's
  // own expression, so an unrelated trailing `?? 'key'` cannot stand in for it, and
  // refused outright when several accesses disagree.
  if (!entry.function && !read.error) {
    const fallback = readFallbackAfterMapAccess(mapSource, entry.map, { mask });
    if (fallback.ambiguous) {
      read.error =
        `${fallback.accesses} real \`${entry.map}[…]\` accesses in ${entry.mapFile} name different fallbacks ` +
        `(${fallback.ambiguous.join(', ')}) — the render site's fallback cannot be pinned while they disagree`;
    } else {
      read.fallbackKey = fallback.key;
    }
  }
  if (read.error) {
    return { id: entry.id, union: entry.union, map: entry.map, values, mapKeys: [], coveringMap: null, missing: [], mapError: read.error };
  }
  return {
    id: entry.id,
    union: entry.union,
    map: entry.map,
    mapLabel: entry.mapLabel ?? entry.map,
    values,
    mapKeys: read.keys,
    mapEntries: read.entries,
    fallbackKey: read.fallbackKey ?? null,
    coveringMap: entry.mapLabel ?? entry.map,
    missing: values.filter((value) => !read.keys.includes(value)),
    mapError: null
  };
}

/**
 * The FAIL detail for a PINNED map that resolved to ZERO keys, or `null` when
 * the map is usable.
 *
 * This is a separate decision from `missing`: a map with zero keys leaves the
 * WHOLE union in `missing`, and the global `enum word map keys` floor does not
 * trip on one map going to zero because the other maps still carry the total over
 * it. So "the map exists but maps nothing" would otherwise be reported exactly
 * like a map that was never added — which is the one thing a pinned name is
 * supposed to distinguish. A pinned name is a promise that the map exists AND
 * translates something; this message holds it, and `routeWordMapGaps` refuses to
 * let an allowlist entry excuse it.
 *
 * Only ever called for a pinned map: for a `map: null` entry there is no name to
 * hold to that promise (see the hazard note in `inspectWordMapEntry`), so the rule
 * for those entries is "no matching allowlist entry" instead, enforced by
 * `allowlistedNullMapEntries`.
 */
function vacuousPinnedMapMessage(entry, inspection) {
  if (inspection.mapKeys.length > 0) return null;
  const site = entry.render ?? 'its render site';
  return `${inspection.mapLabel ?? inspection.map} exists but declares ZERO keys — an emptied map is a regression, not "nothing to map": all ${inspection.values.length} value(s) of ${entry.union} (${inspection.values.join(', ')}) would print raw at ${site}. Restore its entries, or remove the map and pin its replacement.`;
}

/**
 * The FAIL detail for a gap that survived the allowlist: what is missing, and at
 * which map.
 *
 * The prose has to separate the two very different states a gap can be in,
 * because the fix differs: either a map EXISTS and leaves specific values unmapped
 * (name the map AND those values), or NO candidate covers ANY value (then, and
 * only then, say so). Claiming "no word map covers" while a half-covering map sits
 * right there hides both the map that needs one more key and the single value that
 * is missing — the reader is sent to add a map that already exists. Pure, so the
 * self-test can assert the prose directly rather than only through a FAIL line.
 */
function wordMapGapMessage(entry, inspection) {
  const { render } = entry;
  if (inspection.mapError) return `${inspection.mapError} — ${render} would print the raw token(s)`;
  // Pinned-only: a `map: null` entry that resolves to nothing leaves `mapKeys`
  // empty too, but there no map is claimed to exist, so "declares ZERO keys" would
  // name a declaration that is not there. It falls through to the no-coverage
  // wording below, which is the true state.
  if (inspection.map && inspection.mapKeys.length === 0) return vacuousPinnedMapMessage(entry, inspection);
  if (inspection.coveringMap) {
    const covered = inspection.values.filter((value) => inspection.mapKeys.includes(value));
    return (
      `${inspection.coveringMap} covers ${covered.length}/${inspection.values.length} value(s) (${covered.join(', ')}) ` +
      `and leaves ${inspection.missing.length} unmapped: ${inspection.missing.join(', ')} — ${render} would print the raw token(s)`
    );
  }
  return `no word map covers ${inspection.values.join(', ')} — ${render} prints them raw; add a map or allowlist the exact values`;
}

// --- the enum word-map allowlist -------------------------------------------
//
// EMPTY, deliberately. It held one entry — `AutoReviewMode`, whose values were
// printed raw in the `/status` line — and that fix has landed in commit
// `f3d5cd5`: `modeWordKeys` lives in `packages/cli/src/index.ts` with
// `cli.status.modeLenient` / `modeStrict` / `modeUnknown` in both tables of
// `packages/cli/src/language.ts`, so the entry matched nothing and reported
// itself STALE every run. The entry is now deleted AND the map is pinned at
// `ENUM_WORD_MAPS`, so the leak cannot come back by reverting the CLI change: an
// emptied or renamed `modeWordKeys` is a hard FAIL, not a gap this list could
// excuse. With no allowlist entry left, class (B) fails on ANY unmapped enum
// value: the list excuses nothing and only a map that translates every value
// passes.
//
// The machinery is retained for a future structurally-unfixable gap. An entry is
// `{ id, values, reason }` with `values` the EXACT unmapped-values list, matched
// in both directions by `routeWordMapGaps`.
//
// The list may also be empty forever; nothing here assumes a non-empty list.
// Only a NON-EMPTY resolution can be excused: an inspection whose map resolved to
// zero keys is routed to FAIL before the allowlist is consulted (see
// `routeWordMapGaps`), because "the map was emptied" and "the map was never
// added" are the same measurement there — the first is a regression that must
// block and the second must be fixed, not recorded.
const WORD_MAP_ALLOWLIST = [];

/**
 * Partition word-map gaps into INFO (allowlisted to those EXACT values) and
 * FAIL (everything else).
 *
 * The shape differs from `routeDivergences` — an entry here is pinned to a list
 * of unmapped VALUES rather than a concept/language pair — but the contract is
 * identical, and for the same reason: an unmatched gap is a FAIL and there is no
 * default-allow path. Matching is exact in BOTH directions, so a gap that grows
 * (`AutoReviewMode` gains a value) or shrinks (one value gets mapped) stops
 * matching and fails, which is what keeps the entry honest.
 *
 * Two kinds of gap are routed to FAIL BEFORE the allowlist is consulted, so no
 * entry can ever excuse them:
 *
 *   1. A PINNED map that resolved to zero keys. "The map was emptied" and "the
 *      map was never added" produce the same `missing` list, and an allowlist pin
 *      written for the second absorbs the first — the regression goes green. An
 *      entry may only be retired by a map that actually translates something.
 *   2. A `map: null` entry that carries an allowlist entry. With no name pinned,
 *      an emptied map is indistinguishable from a missing one (see the hazard note
 *      in `inspectWordMapEntry`), so the pair is exactly the absorbing combination
 *      above and is rejected on sight — the fix is to pin the name, not to allow
 *      the gap.
 *
 * Escaping both requires a resolve to at least one key under a PINNED name.
 */
function routeWordMapGaps(inspections, allowlist) {
  const passed = [];
  const failed = [];
  for (const inspection of inspections) {
    // Only a PINNED map's gap may be excused — `inspection.map` is the pinned
    // declaration name, and it is null exactly for the score-every-literal entries,
    // where an emptied map and a missing one are the same measurement. So a
    // `map: null` gap ALWAYS falls through to FAIL, whatever the allowlist says:
    // excusing it is precisely the absorption this guard must not perform. The
    // allowlist entry that tried to is named by `allowlistedNullMapEntries`.
    const excusable = Boolean(inspection.map) && !inspection.mapError;
    const entry = excusable
      ? allowlist.find(
          (candidate) =>
            candidate.id === inspection.id &&
            // A pin with NO values excuses nothing: `[]` matches any zero-missing
            // inspection (e.g. one whose map failed to parse) because `every` on an
            // empty list is vacuously true. Requiring at least one value keeps the
            // pin a statement about real unmapped values.
            candidate.values.length > 0 &&
            candidate.values.length === inspection.missing.length &&
            candidate.values.every((value) => inspection.missing.includes(value))
        )
      : null;
    if (inspection.map && inspection.mapKeys.length === 0) {
      failed.push({ ...inspection, vacuousPinnedMap: true });
      continue;
    }
    if (inspection.missing.length === 0) continue;
    if (entry) passed.push({ inspection, entry });
    else failed.push(inspection);
  }
  return { passed, failed };
}

/**
 * `map: null` entries that also carry an allowlist entry — the one combination
 * that silently absorbs "the map was emptied".
 *
 * `routeWordMapGaps` refuses such a gap, but refusing it one gap at a time would
 * let the allowlist entry sit there matching nothing while every future run FAILS
 * for a reason the reader has to reconstruct. Naming the combination directly (the
 * same way the stale-entry loop names a stale entry) points at the fix: pin the
 * map's name.
 */
function allowlistedNullMapEntries(entries, allowlist) {
  return entries.filter(
    (entry) => !entry.map && allowlist.some((candidate) => candidate.id === entry.id)
  );
}

// --- comparison primitives --------------------------------------------------

/**
 * Every key name that appears in two or more dictionaries, with the ids of the
 * dictionaries that declare it. Returned per key rather than as a flat set,
 * because "shared" is a property of a GROUP and the comparison below must pair
 * the members of each group — a key declared by three dictionaries is compared
 * as three pairs, not against one privileged shell.
 */
function joinKeys(tables) {
  const ids = Object.keys(tables);
  const joined = new Map();
  for (const id of ids) {
    for (const key of tables[id].zh.map.keys()) {
      if (!joined.has(key)) joined.set(key, []);
      joined.get(key).push(id);
    }
  }
  return [...joined.entries()]
    .filter(([, dicts]) => dicts.length > 1)
    .map(([key, dicts]) => ({ key, dicts }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The value a `{ dict, key }` reference points at, or `undefined`. */
function valueAt(tables, reference, language) {
  return tables[reference.dict]?.[language]?.map.get(reference.key);
}

/** The normalisation a concept declares before its values are compared. */
function normalise(value, mode) {
  if (mode === 'trim') return value.replace(/^[\s\u3000]+|[\s\u3000]+$/gu, '');
  if (mode === 'stripPathPlaceholder') return value.split('{path}').join('');
  return value;
}

/** Compare one concept in one language; `null` when the two shells agree. */
function compareConcept(tables, concept, language) {
  const left = valueAt(tables, concept.left, language);
  const right = valueAt(tables, concept.right, language);
  if (left === undefined || right === undefined) {
    return { missing: true, concept: concept.concept, language, left, right };
  }
  const comparedLeft = normalise(left, concept.normalize);
  const comparedRight = normalise(right, concept.normalize);
  if (comparedLeft === comparedRight) return null;
  return { concept: concept.concept, language, left: comparedLeft, right: comparedRight, rawLeft: left, rawRight: right };
}

/**
 * Every divergence across the whole map, in a stable order, so the caller can
 * partition them into allowlisted INFO lines and unallowlisted FAIL lines.
 *
 * Two independent axes feed the list:
 *   1. the SHARED_CONCEPT map, which pairs keys that do NOT share a name (the
 *      shells use different namespaces for the same concept); and
 *   2. the key-name join, which pairs keys that DO share a name, across every
 *      dictionary that declares it.
 * Both count into `comparisons`, which is what the non-vacuity floor reads.
 */
function findDivergences(tables, concepts, joinedGroups) {
  const divergences = [];
  let comparisons = 0;
  for (const concept of concepts) {
    for (const language of concept.languages) {
      comparisons += 1;
      const divergence = compareConcept(tables, concept, language);
      if (divergence) divergences.push(divergence);
    }
  }
  for (const { key, dicts } of joinedGroups) {
    for (let a = 0; a < dicts.length; a += 1) {
      for (let b = a + 1; b < dicts.length; b += 1) {
        for (const language of LANGUAGES) {
          comparisons += 1;
          const left = tables[dicts[a]][language].map.get(key);
          const right = tables[dicts[b]][language].map.get(key);
          if (left !== right) {
            divergences.push({
              concept: `key-name join [${key}] ${dicts[a]}\u2194${dicts[b]}`,
              language,
              left,
              right,
              rawLeft: left,
              rawRight: right
            });
          }
        }
      }
    }
  }
  return { divergences, comparisons };
}

// --- the SHARED_CONCEPT map -------------------------------------------------
//
// Derived by reading the three dictionaries, not invented. A pairing is in this
// map when either (1) the audit named it, or (2) its values are byte-identical
// in BOTH languages today — which is the strongest available evidence that the
// shells already treat it as one concept, and therefore that a future edit to
// either side is a regression. Family members whose values legitimately differ
// and that the audit did not name are listed under "does NOT cover" in the
// header instead of being tolerated here.
//
// `normalize` exists because two of these concepts are only equal after the
// layout padding is removed: the web card pads its labels into a monospace
// column (`\u3000` + spaces, per the padding note in `cli.status.*`), while the
// CLI pads to its own column width. The wording is the shared part; the padding
// is a property of each shell's renderer.
const SHARED_CONCEPTS = [
  // The load-bearing state words. Both shells build the key dynamically —
  // web `tr('status.' + state)` (index.html, STATUS_IDS), cli
  // `tr(\`status.${status.state}\`)` — off `AgentStatus` in core, so a rename
  // on either side silently breaks the lookup at runtime with no build error.
  // The 8 keys are ALSO caught by the key-name join below; both are kept,
  // because the join proves the name matches and this proves the wording does.
  ...[
    'status.idle',
    'status.running',
    'status.thinking',
    'status.streaming',
    'status.tool_calling',
    'status.completed',
    'status.aborted',
    'status.error'
  ].map((key) => ({
    concept: `state word [${key}]`,
    left: { dict: 'web', key },
    right: { dict: 'cli', key },
    languages: LANGUAGES
  })),

  // Root/leaf label: web More drawer vs CLI /status.
  { concept: 'leaf label (root)', left: { dict: 'web', key: 'status.card.root' }, right: { dict: 'cli', key: 'cli.status.root' }, languages: LANGUAGES },

  // The /status card quartet the audit named. Same `AgentRunner.getStatus()`
  // fields, different words — allowlisted per language below.
  { concept: 'status card [file]', left: { dict: 'web', key: 'status.card.file' }, right: { dict: 'cli', key: 'cli.status.logFile' }, languages: LANGUAGES, normalize: 'trim' },
  { concept: 'status card [mainModel]', left: { dict: 'web', key: 'status.card.mainModel' }, right: { dict: 'cli', key: 'cli.status.main' }, languages: LANGUAGES, normalize: 'trim' },
  { concept: 'status card [toolModel]', left: { dict: 'web', key: 'status.card.toolModel' }, right: { dict: 'cli', key: 'cli.status.review' }, languages: LANGUAGES, normalize: 'trim' },

  // The session-file labels. The web one is a template with `{path}`; the CLI
  // concatenates the same suffix after its own path, so the comparison strips
  // the placeholder and compares the surviving suffix verbatim — including its
  // leading space, which is what keeps ` (not written yet)` from jamming against
  // the path.
  { concept: 'session file [not written yet]', left: { dict: 'web', key: 'session.file.notWritten' }, right: { dict: 'cli', key: 'cli.logNotWritten' }, languages: LANGUAGES, normalize: 'stripPathPlaceholder' },
  { concept: 'session file [in-memory]', left: { dict: 'web', key: 'session.file.inMemory' }, right: { dict: 'cli', key: 'cli.inMemory' }, languages: LANGUAGES },

  // The empty-history and untitled-session labels.
  { concept: 'empty prompt history', left: { dict: 'web', key: 'menu.history.empty' }, right: { dict: 'cli', key: 'cli.history.empty' }, languages: LANGUAGES },
  { concept: 'untitled session', left: { dict: 'web', key: 'session.untitled' }, right: { dict: 'cli', key: 'cli.sessions.untitled' }, languages: LANGUAGES },

  // The approval card's reviewer attribution; the CLI maps `reviewedBy` through
  // the same two words (packages/cli/src/index.ts, reviewerWordKeys).
  { concept: 'reviewer [rule engine]', left: { dict: 'web', key: 'approval.reviewer.rule' }, right: { dict: 'cli', key: 'cli.approval.reviewerRule' }, languages: LANGUAGES },
  { concept: 'reviewer [review model]', left: { dict: 'web', key: 'approval.reviewer.model' }, right: { dict: 'cli', key: 'cli.approval.reviewerModel' }, languages: LANGUAGES },

  // The risk-level words and the reviewer fallback, both of which the shells
  // build dynamically off core unions — the CLI maps `review.riskLevel` through
  // `riskWordKeys` and an unrecognised `reviewedBy` through
  // `reviewerWordKeys[undefined]` (packages/cli/src/index.ts), while the web card
  // names the same slots `approval.risk.*` / `approval.reviewer.unknown`. The
  // namespaces are disjoint, so the key-name join below cannot see any of this
  // family: it was a coverage hole until these seven pairings existed. All seven
  // are byte-identical in BOTH languages today and are therefore enforced. The
  // reviewer fallback used to diverge — the web card read `自动判定` / `automatic
  // decision` while the CLI read `未知来源` / `unknown source` — and was
  // allowlisted twice; the web wording now matches the CLI and both entries are
  // deleted, so this pairing ENFORCES the concept instead of tolerating it.
  ...[
    ['safe', 'riskSafe'],
    ['low', 'riskLow'],
    ['medium', 'riskMedium'],
    ['high', 'riskHigh'],
    ['critical', 'riskCritical'],
    ['unknown', 'riskUnknown']
  ].map(([level, cliKey]) => ({
    concept: `risk level [${level}]`,
    left: { dict: 'web', key: `approval.risk.${level}` },
    right: { dict: 'cli', key: `cli.approval.${cliKey}` },
    languages: LANGUAGES
  })),
  { concept: 'reviewer [unknown fallback]', left: { dict: 'web', key: 'approval.reviewer.unknown' }, right: { dict: 'cli', key: 'cli.approval.reviewerUnknown' }, languages: LANGUAGES },

  // The About-panel product string; the doc comment above ABOUT_LABELS asserts
  // this identity in prose, which is exactly the kind of claim that rots.
  { concept: 'about credits / product', left: { dict: 'about', key: 'credits' }, right: { dict: 'web', key: 'settings.about.product' }, languages: LANGUAGES },

  // Shared slash-command descriptions. `/status` and `/clear` agree in both
  // languages; `/sessions` does not and is deliberately not asserted (see the
  // header).
  { concept: 'slash /status description', left: { dict: 'web', key: 'slash.status.desc' }, right: { dict: 'cli', key: 'cli.help.status' }, languages: LANGUAGES },
  { concept: 'slash /clear description', left: { dict: 'web', key: 'slash.clear.desc' }, right: { dict: 'cli', key: 'cli.help.clear' }, languages: LANGUAGES },

  // Desktop native-menu labels that mirror a web concept. The zh wording is the
  // translated concept and is enforced; the en casing is a native-HIG choice
  // (allowlisted below).
  { concept: 'menu [newSession]', left: { dict: 'menu', key: 'newSession' }, right: { dict: 'web', key: 'sidebar.new.title' }, languages: LANGUAGES },
  { concept: 'menu [abort]', left: { dict: 'menu', key: 'abort' }, right: { dict: 'web', key: 'composer.stop.title' }, languages: LANGUAGES },
  { concept: 'menu [focusInput]', left: { dict: 'menu', key: 'focusInput' }, right: { dict: 'web', key: 'palette.focus' }, languages: LANGUAGES },
  { concept: 'menu [more]', left: { dict: 'menu', key: 'more' }, right: { dict: 'web', key: 'menu.title' }, languages: LANGUAGES },
  { concept: 'menu [toggleSidebar]', left: { dict: 'menu', key: 'toggleSidebar' }, right: { dict: 'web', key: 'sidebar.toggle' }, languages: LANGUAGES },

  // The streaming "thinking" indicator. zh agrees; the en ellipsis differs.
  { concept: 'transcript thinking', left: { dict: 'web', key: 'transcript.thinking' }, right: { dict: 'cli', key: 'cli.thinking' }, languages: LANGUAGES }
];

// --- the allowlist ----------------------------------------------------------
//
// Real, currently-unfixed divergences. They are NOT this script's to fix: they
// are product-copy decisions spanning two shells, so the guard records each one
// rather than picking a winner. Each entry is printed as an INFO line so the
// divergence stays visible, and each is pinned to the exact values measured
// on the current tree: a divergence that changes SHAPE is a new divergence and
// fails, so an entry cannot rot into a blanket excuse. When the two values
// finally agree the entry is reported as stale and the check still passes.
const ALLOWED_DIVERGENCES = [
  {
    concept: 'status card [file]',
    language: 'en',
    left: { dict: 'web', key: 'status.card.file', value: 'file:' },
    right: { dict: 'cli', key: 'cli.status.logFile', value: 'Log file:' },
    reason: 'Same RunnerCallbacks/AgentRunner.getStatus() field rendered by two shells: the web More panel writes a lowercase label into a padded monospace column, the CLI /status prints `Log file:`. Tolerated because which side moves is a product-copy decision spanning both shells, not a decision this guard may take.'
  },
  {
    concept: 'status card [mainModel]',
    language: 'en',
    left: { dict: 'web', key: 'status.card.mainModel', value: 'main model:' },
    right: { dict: 'cli', key: 'cli.status.main', value: 'Main:' },
    reason: 'Same as `file`: the web card spells the row out (`main model:`) while the CLI abbreviates it (`Main:`). Tolerated for the same reason — unifying the wording is a product-copy decision spanning both shells, so the guard cannot make it here.'
  },
  {
    concept: 'status card [toolModel]',
    language: 'zh',
    left: { dict: 'web', key: 'status.card.toolModel', value: '工具模型：' },
    right: { dict: 'cli', key: 'cli.status.review', value: '审查：' },
    reason: 'Different WORDS, not just layout: the web card calls the review/tool model row `工具模型：` (tool model) while the CLI calls it `审查：` (review). Tolerated because renaming either side is a product-copy decision spanning both shells, and the CLI change is out of scope for this guard.'
  },
  {
    concept: 'status card [toolModel]',
    language: 'en',
    left: { dict: 'web', key: 'status.card.toolModel', value: 'tool model:' },
    right: { dict: 'cli', key: 'cli.status.review', value: 'Review:' },
    reason: 'The en half of the zh divergence above: `tool model:` vs `Review:`. Tolerated on the same grounds — renaming either side is a product-copy decision spanning both shells, and the guard must not pick the winner unilaterally.'
  },
  {
    concept: 'transcript thinking',
    language: 'en',
    left: { dict: 'web', key: 'transcript.thinking', value: 'Thinking…' },
    right: { dict: 'cli', key: 'cli.thinking', value: 'Thinking...' },
    reason: 'Ellipsis style: the web dictionary uses U+2026, the CLI table uses ASCII `...`. The zh values agree (`思考中…`) and ARE enforced. Tolerated because the CLI carries `...` in more than one string, so switching styles is a sweep across terminal copy that no owner has scheduled; a divergence that GROWS beyond this pinned pair fails.'
  },
  {
    concept: 'menu [newSession]',
    language: 'en',
    left: { dict: 'menu', key: 'newSession', value: 'New Session' },
    right: { dict: 'web', key: 'sidebar.new.title', value: 'New session' },
    reason: 'Desktop-vs-web English casing: a native macOS menu item follows AppKit Title Case (`New Session`) while the SPA label is sentence case (`New session`). The zh wording agrees and IS enforced. Tolerated because the desktop label is an AppKit surface with its own HIG convention.'
  },
  {
    concept: 'menu [abort]',
    language: 'en',
    left: { dict: 'menu', key: 'abort', value: 'Abort Turn' },
    right: { dict: 'web', key: 'composer.stop.title', value: 'Abort' },
    reason: 'Desktop-vs-web English casing: the menu item names the operation (`Abort Turn`) where the composer button tooltip is the short verb (`Abort`). The zh wording agrees (`中止本轮`) and IS enforced.'
  },
  {
    concept: 'menu [focusInput]',
    language: 'en',
    left: { dict: 'menu', key: 'focusInput', value: 'Focus Input' },
    right: { dict: 'web', key: 'palette.focus', value: 'Focus Prompt Input' },
    reason: 'Desktop-vs-web English casing: the menu item is terse (`Focus Input`) while the command-palette row names the target (`Focus Prompt Input`). The zh wording agrees (`聚焦输入框`) and IS enforced.'
  }
];

// --- non-vacuity floors -----------------------------------------------------
//
// An extractor that silently finds nothing would make every comparison above
// trivially green — and that is not hypothetical here: slicing the wrong
// marker, or breaking the quote handling, produces exactly that. Each floor is
// pinned just under the count measured on the current tree (parenthesised), so
// it catches a collapsed scan without failing on a normal editorial addition.
const FLOORS = {
  'web zh keys': 250, // 292
  'web en keys': 250, // 292
  'cli zh keys': 70, // 88
  'cli en keys': 70, // 88
  'menu zh keys': 10, // 13
  'menu en keys': 10, // 13
  'about zh keys': 1, // 1
  'about en keys': 1, // 1
  'AgentStatus union states': 8, // 8
  'enum word map entries': 3, // 3 (RiskLevel, reviewedBy, AutoReviewMode)
  'enum word map targets': 5, // 5 (3 CLI maps + the SPA's riskLabel/reviewerLabel maps)
  'web render-site maps': 2, // 2 (riskLabel + reviewerLabel in packages/ui/public/index.html)
  'enum union values': 9, // 9 (5 RiskLevel + 2 reviewedBy + 2 AutoReviewMode), counted per union
  'enum word map keys': 13, // 16 (CLI 5 + 2 + 2, web 5 + 2); floored below the sum so an editorial addition does not trip it
  'word-map fallback keys': 5, // 5 (every render site names one: 3 CLI + 2 web)
  'key-name join keys': 8, // 8
  // 806 = (298 web + 91 cli + 13 menu + 1 about) x 2 languages. A broken table
  // slice yields zero entries, and zero entries is zero findings, so the value
  // scan needs the floor to distinguish "clean" from "read nothing".
  'value detail scan values': 700, // 806
  'concept comparisons': 60, // 68 (34 concepts x 2 languages)
  'value comparisons': 75 // 84 (68 concept + 16 join)
};

/** Which floors the measured metrics fail. Empty array = non-vacuous. */
function floorViolations(metrics) {
  return Object.entries(FLOORS)
    .filter(([metric, floor]) => (metrics[metric] ?? 0) < floor)
    .map(([metric, floor]) => `${metric} = ${metrics[metric] ?? 0} < ${floor}`);
}

// --- output -----------------------------------------------------------------

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  → ${detail}` : ''}`);
}

function info(label, detail) {
  console.log(`INFO  ${label}${detail ? `  → ${detail}` : ''}`);
}

/**
 * Render a value for one-line output.
 *
 * Never truncated: a shortened value would let a PASS line print two identical
 * strings for two different values, which is exactly the kind of silently-green
 * reporting this guard exists to avoid. The longest dictionary value is ~100
 * characters, so the full text fits.
 */
function show(value) {
  if (value === undefined) return '<missing>';
  return JSON.stringify(value);
}

/**
 * Render a pair of values that the checks have found DIFFERENT, guaranteeing
 * the printed line distinguishes them.
 *
 * Plain `show()` on both sides is enough while they are short, but the longest
 * values here run past 100 characters: two long strings that differ only near
 * the end would print as two identical suffixes if the printer truncated. So
 * when either rendering is long, the first differing position is located and a
 * window around it is printed with the offset, which makes the difference
 * visible no matter where it falls.
 */
function showDiff(left, right) {
  if (left === undefined || right === undefined) return `${show(left)} ≠ ${show(right)}`;
  const renderedLeft = JSON.stringify(left);
  const renderedRight = JSON.stringify(right);
  if (renderedLeft.length <= 48 && renderedRight.length <= 48) return `${renderedLeft} ≠ ${renderedRight}`;
  let at = 0;
  while (at < left.length && at < right.length && left[at] === right[at]) at += 1;
  const from = Math.max(0, at - 12);
  const window = (value) => {
    const piece = JSON.stringify(value.slice(from, from + 40)).slice(1, -1);
    return `"${from > 0 ? '…' : ''}${piece}${from + 40 < value.length ? '…' : ''}"`;
  };
  return `${window(left)} ≠ ${window(right)}  (first difference at character ${at}; lengths ${left.length}/${right.length})`;
}

// --- extract -----------------------------------------------------------------

const sources = DICTIONARIES.map((entry) => ({
  ...entry,
  source: fs.readFileSync(path.join(REPO, entry.file), 'utf-8')
}));

const broken = [];
for (const source of sources) {
  const preview = buildTables([source])[source.id];
  for (const language of LANGUAGES) {
    if (preview[language].error) broken.push(`${source.label} ${language}: ${preview[language].error}`);
  }
}
if (broken.length > 0) {
  console.error('FAIL  could not slice every dictionary table');
  for (const message of broken) console.error(`      ${message}`);
  process.exit(1);
}

const tables = buildTables(sources);

// --- (1) extraction is non-empty, per table --------------------------------

const metrics = {};
for (const entry of sources) {
  for (const language of LANGUAGES) {
    metrics[`${entry.id} ${language} keys`] = tables[entry.id][language].map.size;
  }
}
for (const entry of sources) {
  for (const language of LANGUAGES) {
    const table = tables[entry.id][language];
    const metric = `${entry.id} ${language} keys`;
    check(
      `${entry.label} ${language} table block is non-empty`,
      table.map.size >= FLOORS[metric],
      `${table.map.size} keys from ${table.lines} lines (commencing line ${table.startLine}, floor ${FLOORS[metric]})`
    );
  }
}

// --- (2a) intra-table parity: zh and en cover identical keys ---------------

for (const entry of sources) {
  const zhKeys = [...tables[entry.id].zh.map.keys()];
  const enKeys = new Set(tables[entry.id].en.map.keys());
  const missingInEn = zhKeys.filter((key) => !enKeys.has(key));
  const missingInZh = [...enKeys].filter((key) => !tables[entry.id].zh.map.has(key));
  const gaps = [...missingInEn.map((key) => `${key} (zh only)`), ...missingInZh.map((key) => `${key} (en only)`)];
  check(
    `${entry.label}: zh and en cover identical keys`,
    gaps.length === 0,
    gaps.length ? gaps.join(', ') : `zh=${zhKeys.length} en=${enKeys.size}`
  );
}

// --- (2b) duplicate keys ---------------------------------------------------

for (const entry of sources) {
  for (const language of LANGUAGES) {
    const duplicates = tables[entry.id][language].duplicates;
    check(
      `${entry.label} ${language}: no duplicate keys`,
      duplicates.length === 0,
      duplicates.length
        ? duplicates.map((d) => `${d.key} (line ${d.line})`).join(', ')
        : `${tables[entry.id][language].map.size} distinct keys`
    );
  }
}

// --- (7) implementation detail in dictionary VALUES --------------------------
//
// This file owns the value-side half of the implementation-detail rule set, and
// `check-ui-i18n.mjs` owns the display-sink and annotated-element halves. The
// split follows the parsers rather than splitting a parser: this file already
// slices both language tables of all FOUR dictionaries (`web`, `cli`, `menu`,
// `about`) with `readTable`, and the UI guard never opens the CLI or desktop
// dictionaries. Putting the value half here covers `packages/cli/src/language.ts`
// — which no check in the UI guard could see — without a second table slicer.
//
// Why a value needs its own check at all: a dictionary value is the one place
// every other check treats as APPROVED copy. The key resolves, the two tables
// agree, `looksLikeCopy` sees a sentence — and the settings hint that read
// `Stored locally in /Users/kayphoon/.myagent/ui-settings.json (0600), using
// OPENAI_API_KEY to call /models.` passed all four guards. The shapes below are
// the defect's own shapes.
//
// The four patterns are character-for-character the ones in
// `check-ui-i18n.mjs`'s `IMPLEMENTATION_DETAIL_SHAPES`; the two files share no
// module boundary (both are standalone scripts run by `pnpm test`), so the rule
// set is written once per file, and a rule added to one must be added to the
// other. The self-test below pins each shape in BOTH directions so a silent
// divergence in one file fails its own suite.
const VALUE_DETAIL_SHAPES = [
  {
    id: 'filesystem path',
    pattern: /(?:^|[\s(（"'`=:;,])[A-Za-z]:\\|(?:^|[\s(（"'`=:;,])[/](?![a-z\s])[\w.~-]|(?:^|[\s(（"'`=:;,])(?:~\/[\w.-]+(?:\/[\w.-]+)*\/?|\.{1,2}\/[\w.-]+(?:\/[\w.-]+)*\/?|\.[\w-]+\/[\w.-]+(?:\/[\w.-]+)*\/?|\.[\w-]+\/)/
  },
  {
    id: 'file mode',
    pattern: /(?:^|[\s(（])0[0-7]{3}(?:[\s)）.。]|$)|(?:权限|permission|chmod|mode bits)[^\n]{0,16}?(?<![\d])[0-7]{3,4}(?![\d])/i
  },
  {
    id: 'environment variable',
    pattern: /(?:^|[^A-Za-z0-9_])([A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+)(?![A-Za-z0-9_])/
  },
  {
    id: 'bare endpoint',
    pattern: /(?:^|[\s(（"'`])(\/[a-z][\w./-]*)/
  }
];

/**
 * The slash commands the product implements, read from the code that implements
 * them rather than listed here.
 *
 * `'清除当前上下文 (/clear)'` is documented product syntax, not a leaked route, and
 * an allowlist of six strings would have to be re-edited every time a command is
 * added. The set is read from the CLI dispatch (`case '/clear':`) and the SPA's
 * completion entries (`name: '/status'`), so a command added tomorrow is
 * excluded the moment it is implemented and a real endpoint is never in it.
 */
function productSlashCommands() {
  const commands = new Set();
  for (const file of ['packages/cli/src/index.ts', 'packages/ui/public/index.html']) {
    const read = readSourceFile(file);
    if (read.error) continue;
    for (const match of read.source.matchAll(/case\s+'(\/[a-z][\w-]*)'/g)) commands.add(match[1]);
    for (const match of read.source.matchAll(/name:\s*'(\/[a-z][\w-]*)'/g)) commands.add(match[1]);
  }
  return commands;
}

/**
 * Every implementation-detail shape a dictionary VALUE carries.
 *
 * Named so the self-test drives this code rather than a copy of the loop.
 */
function valueDetailHits(value, commands) {
  const hits = [];
  for (const { id, pattern } of VALUE_DETAIL_SHAPES) {
    const match = pattern.exec(value);
    if (!match) continue;
    if (id === 'bare endpoint' && commands.has(match[1] ?? match[0])) continue;
    hits.push(`${id}: ${JSON.stringify(match[1] ?? match[0])}`);
  }
  return hits;
}

const productSlashCommandSet = productSlashCommands();
check(
  'slash-command set was derived from the implementing code (value rules)',
  productSlashCommandSet.size >= 8,
  `${productSlashCommandSet.size} commands: ${[...productSlashCommandSet].sort().join(', ')}`
);

let valueDetailScanned = 0;
let valueDetailFindings = 0;
for (const entry of sources) {
  for (const language of LANGUAGES) {
    const findings = [];
    for (const record of tables[entry.id][language].entries) {
      valueDetailScanned += 1;
      const hits = valueDetailHits(record.value, productSlashCommandSet);
      if (hits.length) findings.push({ ...record, hits });
    }
    valueDetailFindings += findings.length;
    check(
      `${entry.label} ${language}: no implementation detail in a dictionary value`,
      findings.length === 0,
      findings.length
        ? findings.map((f) => `${JSON.stringify(f.key)} (line ${f.line}) ${show(f.value)} → ${f.hits.join(' | ')}`).join(' | ')
        : `${tables[entry.id][language].entries.length} values checked`
    );
  }
}

// The floor: a scan that read no values would make every check above trivially
// green, which is the failure mode a value scan is most exposed to (a broken
// table slice yields zero entries, and zero entries is zero findings).
metrics['value detail scan values'] = valueDetailScanned;
check(
  'the value implementation-detail scan read real values',
  valueDetailScanned >= FLOORS['value detail scan values'],
  `${valueDetailScanned} values across ${sources.length} dictionaries x ${LANGUAGES.length} languages (floor ${FLOORS['value detail scan values']})`
);

// --- (3a) key-name join ----------------------------------------------------

const joinedGroups = joinKeys(tables);
metrics['key-name join keys'] = joinedGroups.length;
check(
  'key-name join across dictionaries',
  joinedGroups.length >= FLOORS['key-name join keys'],
  joinedGroups.length
    ? `${joinedGroups.length} shared key names x ${LANGUAGES.length} languages (floor ${FLOORS['key-name join keys']}): ${joinedGroups.map((group) => group.key).join(', ')}`
    : `no shared key names found (floor ${FLOORS['key-name join keys']})`
);

// --- (3b) the shared-concept map -------------------------------------------

const { divergences, comparisons } = findDivergences(tables, SHARED_CONCEPTS, joinedGroups);
const conceptComparisons = SHARED_CONCEPTS.reduce((sum, concept) => sum + concept.languages.length, 0);
metrics['concept comparisons'] = conceptComparisons;
metrics['value comparisons'] = comparisons;

/**
 * Partition divergences into INFO (allowlisted) and FAIL (new).
 *
 * Pure and exported to the self-test on purpose: the partition is the single
 * decision that separates "a known divergence stays visible" from "a new one
 * blocks the build", so it must be provable against synthetic findings rather
 * than only against whatever happens to be on the tree today. An unmatched
 * divergence is a FAIL — there is no default-allow path.
 */
function routeDivergences(divergences, allowlist) {
  const passed = [];
  const failed = [];
  for (const divergence of divergences) {
    const entry = allowlist.find(
      (candidate) => candidate.concept === divergence.concept && candidate.language === divergence.language
    );
    if (entry) passed.push({ divergence, entry });
    else failed.push(divergence);
  }
  return { passed, failed };
}

// --- print the shared-concept agreement lines ------------------------------

const conceptFindings = divergences.filter((divergence) => !divergence.concept.startsWith('key-name join'));
const conceptNames = new Set(conceptFindings.map((divergence) => `${divergence.concept}/${divergence.language}`));
for (const concept of SHARED_CONCEPTS) {
  for (const language of concept.languages) {
    if (conceptNames.has(`${concept.concept}/${language}`)) continue;
    const allowlisted = ALLOWED_DIVERGENCES.find((entry) => entry.concept === concept.concept && entry.language === language);
    if (allowlisted) continue;
    const left = valueAt(tables, concept.left, language);
    const right = valueAt(tables, concept.right, language);
    check(
      `shared concept [${concept.concept}] ${language}`,
      true,
      `${concept.left.dict} ${concept.left.key} = ${show(left)} ≡ ${concept.right.dict} ${concept.right.key} = ${show(right)}`
    );
  }
}

// --- (3c) divergences: allowlisted -> INFO, new -> FAIL --------------------

const { passed: allowlistedFindings, failed: newDivergences } = routeDivergences(divergences, ALLOWED_DIVERGENCES);

for (const { divergence, entry } of allowlistedFindings) {
  info(
    `allowlisted divergence [${divergence.concept}] ${divergence.language}`,
    `${showDiff(divergence.left, divergence.right)}  (${entry.reason})`
  );
}

for (const divergence of newDivergences) {
  check(
    `cross-dictionary divergence [${divergence.concept}] ${divergence.language}`,
    false,
    showDiff(divergence.left, divergence.right)
  );
}

// A concept whose keys are missing entirely would otherwise drop out of the
// comparison loop silently, so existence is asserted separately.
for (const concept of SHARED_CONCEPTS) {
  for (const reference of [concept.left, concept.right]) {
    for (const language of concept.languages) {
      const present = valueAt(tables, reference, language) !== undefined;
      if (!present) {
        check(
          `shared concept key exists [${concept.concept}] ${language}`,
          false,
          `${reference.dict} is missing ${JSON.stringify(reference.key)}`
        );
      }
    }
  }
}

// An allowlist entry whose values have been unified is stale, not a failure —
// but it must not stay silent, or the list becomes a dumping ground.
for (const entry of ALLOWED_DIVERGENCES) {
  const concept = SHARED_CONCEPTS.find((candidate) => candidate.concept === entry.concept);
  if (!concept) continue;
  const divergence = compareConcept(tables, concept, entry.language);
  if (!divergence) {
    info(
      `stale allowlist entry [${entry.concept}] ${entry.language}`,
      `the two values now agree — remove this entry (${entry.left.dict} ${entry.left.key} = ${show(valueAt(tables, entry.left, entry.language))})`
    );
    continue;
  }
  if (divergence.missing) continue;
  if (divergence.left !== entry.left.value || divergence.right !== entry.right.value) {
    check(
      `allowlisted divergence changed shape [${entry.concept}] ${entry.language}`,
      false,
      `recorded ${showDiff(entry.left.value, entry.right.value)}, now ${showDiff(divergence.left, divergence.right)} — re-justify or fix`
    );
  }
}

// --- (4) the dynamic status lookup -----------------------------------------

const statusSource = fs.readFileSync(path.join(REPO, STATUS_TYPE_FILE), 'utf-8');
const unionMatch = statusSource.match(/export type AgentStatus\s*=([\s\S]*?);/);
const states = unionMatch ? [...unionMatch[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]) : [];
metrics['AgentStatus union states'] = states.length;
check(
  `AgentStatus union parsed from ${STATUS_TYPE_FILE}`,
  states.length >= FLOORS['AgentStatus union states'],
  states.length ? `${states.length} states: ${states.join(', ')} (floor ${FLOORS['AgentStatus union states']})` : 'no states found'
);
for (const state of states) {
  const key = `status.${state}`;
  const missing = [];
  for (const [dict, language] of [['web', 'zh'], ['web', 'en'], ['cli', 'zh'], ['cli', 'en']]) {
    if (!tables[dict][language].map.has(key)) missing.push(`${dict} ${language}`);
  }
  check(
    `status lookup key defined for every state [${key}]`,
    missing.length === 0,
    missing.length ? `missing in ${missing.join(', ')}` : `web+cli, zh+en, all agree`
  );
}

// --- (5) core enum -> render-site word map ---------------------------------
//
// §4 proves a `status.*` KEY exists per `AgentStatus` value. This proves the
// other direction of the same promise: an enum value a shell interpolates into a
// user-visible string has a WORD. The entries, their render sites and the
// extraction technique are documented at ENUM_WORD_MAPS above. Every target pins a
// map by name, and a pinned map must resolve to at least one key, so a deleted,
// renamed or EMPTIED map all FAIL; the recorded-gap mechanism at
// WORD_MAP_ALLOWLIST is retained but empty.
//
// The targets are BOTH shells' render sites (§5a the CLI's file-scope maps, §5b
// the SPA's function-local ones), flattened by `wordMapTargets()` so they share
// one reader, one gap router, one allowlist and one set of floors.

/** Read a file, or return the message rather than throwing into a stack trace. */
function readSourceFile(file) {
  try {
    return { source: fs.readFileSync(path.join(REPO, file), 'utf-8') };
  } catch (error) {
    return { error: `${file}: ${error.code ?? error.message}` };
  }
}

/** A word-map target's human label: the declaration name, shell-qualified. */
function targetLabel(entry) {
  return `${entry.mapLabel} [${entry.id}]`;
}

const enumTargets = wordMapTargets();
const enumInspections = enumTargets.map((entry) => {
  const core = readSourceFile(entry.file);
  const map = readSourceFile(entry.mapFile);
  if (core.error || map.error) {
    return { entry, error: [core.error, map.error].filter(Boolean).join('; ') };
  }
  return { entry, inspection: inspectWordMapEntry(entry, core.source, map.source) };
});

const brokenEnumSources = enumInspections.filter((candidate) => candidate.error);
for (const { entry, error } of brokenEnumSources) {
  check(`enum word map sources readable [${entry.id}]`, false, error);
}

const readableInspections = enumInspections.filter((candidate) => !candidate.error);

metrics['enum word map entries'] = ENUM_WORD_MAPS.length;
// Counted from the READABLE targets, not from the pinned list: a target whose
// file is missing or whose anchor is renamed must drop these counts below their
// floors, or that failure would rest on the key sum alone and a future map with
// no keys would pass both.
metrics['enum word map targets'] = readableInspections.length;
metrics['web render-site maps'] = readableInspections.filter(({ entry }) => entry.shell === 'web').length;
// Counted per UNION, not per target: the two shells read the same alias, so
// summing over targets would double 5+2+2 into 16 and the floor would have to
// track how many shells happen to be covered — a metric that moves when coverage
// GROWS is the wrong thing to floor.
metrics['enum union values'] = ENUM_WORD_MAPS.reduce(
  (sum, entry) => sum + (readableInspections.find(({ entry: target }) => target.union === entry.union)?.inspection.values.length ?? 0),
  0
);
metrics['enum word map keys'] = enumInspections
  .filter((candidate) => !candidate.error)
  .reduce((sum, { inspection }) => sum + inspection.mapKeys.length, 0);
// How many render sites name a `?? '…'` fallback. Every render site in
// ENUM_WORD_MAPS has one today, so a floor keeps the check from silently going
// quiet if `readFallbackAfterMapAccess` stops finding them.
metrics['word-map fallback keys'] = enumInspections
  .filter((candidate) => !candidate.error)
  .filter(({ inspection }) => Boolean(inspection.fallbackKey)).length;

// The union parse is a property of the ENUM, not of one shell's map, so it is
// asserted once per entry: the two shells read the same alias and reporting it
// twice per enum would double the line without adding a fact.
for (const entry of ENUM_WORD_MAPS) {
  const candidates = readableInspections.filter(({ entry: target }) => target.union === entry.union);
  const label = `${entry.union} (${entry.file})`;
  const values = candidates[0]?.inspection.values ?? [];
  // A union parse that yields nothing is the vacuous case: a renamed alias, a
  // reformatted union, or a mistyped file path would otherwise read as "nothing
  // to map" and pass. It FAILS here, naming the entry.
  check(
    `enum union parsed for word mapping [${label}]`,
    values.length > 0,
    values.length ? `${values.length} values: ${values.join(', ')}` : `no values parsed from ${entry.union} (declaration renamed or moved?)`
  );
}

for (const { entry, inspection } of readableInspections) {
  if (inspection.mapError) {
    check(`enum word map declared [${entry.id}]`, false, `${inspection.mapError} — the render site (${entry.render}) would print raw tokens`);
  }
}

const { passed: allowlistedGaps, failed: newGaps } = routeWordMapGaps(
  readableInspections.map(({ inspection }) => inspection),
  WORD_MAP_ALLOWLIST
);

// An entry that pins no map AND is allowlisted is the combination that absorbs
// an emptied map (the map would read as absent and the pin would match), so it is
// named directly rather than only failing gap by gap. Keyed off the flattening so
// a `map: null` shape cannot slip in through a `web` block unexamined.
for (const entry of allowlistedNullMapEntries(enumTargets, WORD_MAP_ALLOWLIST)) {
  check(
    `unpinned word map entry is not also allowlisted [${entry.id}]`,
    false,
    `\`map: null\` cannot distinguish an emptied map from a missing one, so \`${entry.id}\` with a WORD_MAP_ALLOWLIST entry would absorb the regression — pin the map's name instead`
  );
}

// A covered value is reported, so a reader can see which values ARE translated
// rather than only which are not.
for (const { entry, inspection } of readableInspections) {
  if (inspection.missing.length > 0) continue;
  const covered = inspection.values.filter((value) => inspection.mapKeys.includes(value));
  check(
    `every value of ${entry.union} has a word [${targetLabel(entry)}]`,
    true,
    `${covered.length}/${inspection.values.length} mapped: ${covered.join(', ') || 'none'} (${entry.render})`
  );
}

// A map pinned by name that resolves to nothing is its own failure, independent
// of the gap routing: the gap would look exactly like "the map was never added",
// so the name's promise has to be asserted separately. Checked before the routes
// below so the reader sees the cause next to the coverage evidence.
for (const { entry, inspection } of readableInspections) {
  const vacuous = inspection.map && !inspection.mapError ? vacuousPinnedMapMessage(entry, inspection) : null;
  check(
    `pinned word map is not empty [${targetLabel(entry)}]`,
    vacuous === null,
    vacuous ?? `${inspection.mapLabel ?? inspection.map} declares ${inspection.mapKeys.length} keys`
  );
}

// --- (5b) the ROUTING of a word map, not merely its coverage ----------------
//
// §5 proves each enum value has a key IN its map. That leaves three defects
// green: a target repointed at another value's word (`riskWordKeys.high ->
// 'cli.approval.riskLow'`), a target renamed to a key its own dictionary does not
// define (the surface would print the raw key string), and two values sharing one
// target (every level rendered as the same word). Both shells' maps are checked
// with the SAME three assertions, because the escapes exist identically on each.

/** The key/value pairs a pinned map declares, as `{ key, value, line }`. */
function mapPairs(inspection) {
  return inspection.mapEntries ?? [];
}

/** The dictionary table a shell's word keys live in. */
const WORD_MAP_DICTIONARY = { cli: 'cli', web: 'web' };

/**
 * The target `inspection` maps `value` to, or `undefined` when the map has no
 * entry for it (the coverage checks already reported that).
 */
function targetFor(inspection, value) {
  const pair = mapPairs(inspection).find((candidate) => candidate.key === value);
  return pair ? pair.value : undefined;
}

/**
 * Whether `sharedConcepts` records these two targets as the same concept.
 *
 * The dictionary ids are arguments rather than the literals `web`/`cli`: the
 * self-test drives this with fixture dictionaries named `webDict`/`cliDict`, and a
 * hardcoded pair would make every fixture read as unpaired — which is how a
 * mis-route test passes for the wrong reason (everything looks misrouted) and the
 * healthy negative control fails. The real run passes `WORD_MAP_DICTIONARY`'s ids.
 */
function recordedPairing(sharedConcepts, webTarget, cliTarget, webDictionary, cliDictionary) {
  return sharedConcepts.find(
    (concept) =>
      (concept.left.dict === webDictionary && concept.left.key === webTarget && concept.right.dict === cliDictionary && concept.right.key === cliTarget) ||
      (concept.left.dict === cliDictionary && concept.left.key === cliTarget && concept.right.dict === webDictionary && concept.right.key === webTarget)
  );
}

/**
 * Every routing defect one shell's word map can have, measured — the three the
 * coverage check in §5 cannot see. Pure, and takes the shared-concept list as an
 * argument, so the self-test drives it with synthetic fixtures and the real run
 * passes the real map.
 *
 *   1. `undefinedTargets` — a target that is not a key of the shell's own
 *      dictionary. The map names a word per value, so coverage is "complete" and
 *      the surface prints the raw key string.
 *   2. `sharedTargets` — two values pointing at one target, so two different
 *      risks render identically.
 *   3. `misrouted` — a value whose (web, cli) target pair is NOT a concept the
 *      shared-concept map records. This is the axis that catches
 *      `riskWordKeys.high -> 'cli.approval.riskLow'`, and it is the reason the
 *      pairing is DERIVED from `SHARED_CONCEPTS` rather than restated as a
 *      level→key table here: a second table in this file could drift from the
 *      dictionary the way the map under test did.
 */
function wordMapRoutingFindings({ inspection, webInspection, dictionary, webDictionary, tables, sharedConcepts }) {
  const pairs = mapPairs(inspection);

  const undefinedTargets = dictionary
    ? pairs.filter((pair) => !tables[dictionary].zh.map.has(pair.value) || !tables[dictionary].en.map.has(pair.value))
    : [];

  const byTarget = new Map();
  for (const pair of pairs) {
    if (!byTarget.has(pair.value)) byTarget.set(pair.value, []);
    byTarget.get(pair.value).push(pair.key);
  }
  const sharedTargets = [...byTarget.entries()].filter(([, keys]) => keys.length > 1);

  const misrouted = [];
  if (webInspection && pairs.length > 0 && mapPairs(webInspection).length > 0) {
    for (const value of inspection.values) {
      const cliTarget = targetFor(inspection, value);
      const webTarget = targetFor(webInspection, value);
      if (!cliTarget || !webTarget) continue;
      if (recordedPairing(sharedConcepts, webTarget, cliTarget, webDictionary, dictionary)) continue;
      // Name the specific shape of the mis-route when the target is another value's
      // word — that is the case worth calling out, and it is measurable exactly.
      const otherValue = inspection.values.find((other) => other !== value && targetFor(inspection, other) === cliTarget);
      misrouted.push(
        `${value}: web ${JSON.stringify(webTarget)} / cli ${JSON.stringify(cliTarget)}` +
          (otherValue ? ` (cli target is the word of \`${otherValue}\`)` : ' (no recorded pairing for this pair)')
      );
    }
  }

  return { undefinedTargets, sharedTargets, misrouted };
}

/** The web target paired with a CLI target, keyed by the enum id. */
const webInspectionFor = new Map();
for (const { entry, inspection } of readableInspections) {
  if (entry.shell === 'web') webInspectionFor.set(entry.id.replace(/@web$/, ''), inspection);
}

/** How many distinct targets a map declares (the denominator of check (ii)). */
function byTargetSize(inspection) {
  return new Set(mapPairs(inspection).map((pair) => pair.value)).size;
}

for (const { entry, inspection } of readableInspections) {
  if (inspection.mapError) continue;
  const pairs = mapPairs(inspection);
  if (pairs.length === 0) continue; // the vacuous-map check above already FAILED it

  const dictionary = WORD_MAP_DICTIONARY[entry.shell];
  if (!dictionary) continue; // a shell with no registered dictionary cannot be resolved
  const webInspection = entry.shell === 'cli' ? webInspectionFor.get(entry.id) : null;
  const { undefinedTargets, sharedTargets, misrouted } = wordMapRoutingFindings({
    inspection,
    webInspection: webInspection && !webInspection.mapError ? webInspection : null,
    dictionary,
    webDictionary: WORD_MAP_DICTIONARY.web,
    tables,
    sharedConcepts: SHARED_CONCEPTS
  });

  // (i) Every target must be a key of the shell's OWN dictionary. Without this a
  // rename to `approval.risk.nope` is "complete" — the map still names a value per
  // key — and the SPA prints the raw key string to the user.
  check(
    `every ${entry.shell} word-map target is a defined ${dictionary} dictionary key [${targetLabel(entry)}]`,
    undefinedTargets.length === 0,
    undefinedTargets.length
      ? undefinedTargets
          .map((pair) => `${pair.key} -> ${JSON.stringify(pair.value)} (line ${pair.line}) is not in the ${dictionary} dictionary`)
          .join('; ')
      : `${pairs.length} target(s) all defined in ${dictionary} zh+en`
  );

  // (i-b) The render site names a SECOND key: the `?? '…'` fallback an
  // unrecognised value from a newer core falls back to. It is a dictionary key like
  // any other, so renaming it to one the dictionary does not define prints a raw key
  // string for every unknown value while the coverage counts stay green. Read from
  // the site (never hardcoded) and asserted here.
  if (inspection.fallbackKey) {
    const defined =
      tables[dictionary].zh.map.has(inspection.fallbackKey) && tables[dictionary].en.map.has(inspection.fallbackKey);
    check(
      `${entry.shell} word-map fallback key is defined in the ${dictionary} dictionary [${targetLabel(entry)}]`,
      defined,
      defined
        ? `?? ${JSON.stringify(inspection.fallbackKey)} resolves in ${dictionary} zh+en`
        : `?? ${JSON.stringify(inspection.fallbackKey)} is NOT in the ${dictionary} dictionary — an unrecognised value would print the raw key string`
    );
  }

  // (ii) Two levels must not share a word: `low` and `high` pointing at the same
  // dictionary key renders two different risks identically, which no coverage
  // count can see because every value is still "mapped".
  check(
    `no two values of ${entry.union} share a ${entry.shell} word-map target [${targetLabel(entry)}]`,
    sharedTargets.length === 0,
    sharedTargets.length
      ? sharedTargets.map(([value, keys]) => `${keys.join(' + ')} both -> ${JSON.stringify(value)}`).join('; ')
      : `${byTargetSize(inspection)} distinct targets for ${pairs.length} entries`
  );

  if (entry.shell !== 'cli') continue;
  // (iii) The CROSS-SHELL routing, which is what catches the mis-routing case: for
  // one enum value, the web map's target and the CLI map's target must be a pair
  // `SHARED_CONCEPTS` already establishes as the same concept (their words are
  // byte-equal in both languages, which is why they are asserted there). Every one
  // of these slots is paired today — the five risk levels and the two reviewer
  // sources — so the assertion is exact rather than heuristic.
  //
  // `riskWordKeys.high -> 'cli.approval.riskLow'` fails because the CLI target at
  // `high` is then `cli.approval.riskLow`, while the only web key paired with
  // `cli.approval.riskHigh` is `approval.risk.high` and the only concept pairing
  // `cli.approval.riskLow` is `approval.risk.low`. No recorded concept pairs
  // (`approval.risk.high`, `cli.approval.riskLow`), so the mis-route is reported
  // naming `high`. A coverage-only check cannot see it: every value still has a key
  // in the map. Deriving the pairing from `SHARED_CONCEPTS` rather than restating a
  // level→key table means both shells renaming to a NEW namespace fails here for the
  // honest reason (the pairing is no longer recorded) instead of passing on a
  // hardcoded list that had drifted out of the dictionary.
  if (!webInspection || webInspection.mapError) continue;
  check(
    `web and cli route each ${entry.union} value to the same word [${entry.union}]`,
    misrouted.length === 0,
    misrouted.length
      ? `the two shells route differently: ${misrouted.join('; ')} — a value mapped to a word no longer paired with the web target is complete-but-wrong coverage`
      : `${inspection.values.length} value(s) paired: ${inspection.values
          .map((value) => `${value} -> web ${JSON.stringify(targetFor(webInspection, value) ?? '<none>')} / cli ${JSON.stringify(targetFor(inspection, value) ?? '<none>')}`)
          .join(', ')}`
  );
}

for (const { inspection, entry } of allowlistedGaps) {
  info(
    `unmapped core enum [${inspection.id}]`,
    `${inspection.values.length - inspection.missing.length}/${inspection.values.length} mapped, unmapped: ${inspection.missing.join(', ')} (${entry.reason})`
  );
}

for (const inspection of newGaps) {
  const entry = enumTargets.find((candidate) => candidate.id === inspection.id);
  check(`unmapped core enum [${inspection.id}]`, false, wordMapGapMessage(entry, inspection));
}

// An allowlist entry whose union is now fully covered is stale, not a failure —
// but it must not stay silent, or the list becomes a dumping ground. An empty
// list reports nothing here, which is the healthy state.
for (const entry of WORD_MAP_ALLOWLIST) {
  const found = enumInspections.find((candidate) => candidate.entry.id === entry.id);
  if (!found) {
    check(`allowlisted unmapped enum still exists [${entry.id}]`, false, `no ENUM_WORD_MAPS entry named ${entry.id} — remove the allowlist entry`);
    continue;
  }
  if (found.error) continue;
  if (found.inspection.missing.length === 0) {
    info(
      `stale word-map allowlist entry [${entry.id}]`,
      `every value is now mapped (${found.inspection.coveringMap}) — remove this entry`
    );
  }
}

// --- (6) non-vacuity -------------------------------------------------------

const violations = floorViolations(metrics);
check(
  'every check compared a non-vacuous number of keys and values',
  violations.length === 0,
  violations.length
    ? violations.join('; ')
    : `${conceptComparisons} concept comparisons + ${comparisons - conceptComparisons} join comparisons = ${comparisons} value comparisons`
);

// --- self-test: the detectors must be able to fail -------------------------

// Every case below drives the SAME extraction, comparison and floor code the
// real run uses, against synthetic dictionary sources. Testing the primitives
// in isolation would not prove that slicing reaches a table, nor that the
// divergence partition still routes a finding to FAIL.

/**
 * A synthetic dictionary file. `decl`/`end` mirror the real files so the
 * fixtures travel through identical slicing. Keys are passed bare and quoted
 * by the renderer, exactly as the real dictionaries quote them.
 */
function fixtureSource(name, zhEntries, enEntries) {
  const render = (entries) => entries.map(([key, value]) => `    '${key}': ${value}`).join(',\n');
  return `const ${name} = {\n  zh: {\n${render(zhEntries)}\n  },\n  en: {\n${render(enEntries)}\n  }\n};\n`;
}

/** One fixture dictionary, under a per-fixture name so the join can pair two. */
function fixtureTables(name, zhEntries, enEntries) {
  return buildTables([{ id: name, label: name, decl: `const ${name} = {`, end: '\n};', source: fixtureSource(name, zhEntries, enEntries) } ]);
}

/**
 * Two rival dictionaries built from the same entry shape, so the key-name join
 * is exercised across dictionaries rather than inside one — which is the only
 * way the join can do anything.
 */
function rivalTables(leftZh, leftEn, rightZh, rightEn) {
  return { ...fixtureTables('leftDict', leftZh, leftEn), ...fixtureTables('rightDict', rightZh, rightEn) };
}

/** One fixture concept, so the cross-dictionary comparison path is exercised. */
const FIXTURE_CONCEPT = {
  concept: 'fixture concept',
  left: { dict: 'leftDict', key: 'shared.label' },
  right: { dict: 'rightDict', key: 'shared.label' },
  languages: LANGUAGES
};

{
  // The fixture travels through extraction at all: without this, every case
  // below could pass because extraction returned nothing.
  const single = fixtureTables('soloDict', [['alpha', "'甲'"], ['beta', "'乙'"]], [['alpha', "'A'"], ['beta', "'B'"]]);
  check(
    'self-test: the fixture travels through extraction',
    single.soloDict.zh.map.size === 2 && single.soloDict.en.map.size === 2,
    `${single.soloDict.zh.map.size} zh / ${single.soloDict.en.map.size} en keys`
  );

  const agreeing = rivalTables(
    [['shared.label', "'甲'"]], [['shared.label', "'Alpha'"]],
    [['shared.label', "'甲'"]], [['shared.label', "'Alpha'"]]
  );
  const agreeingResult = findDivergences(agreeing, [FIXTURE_CONCEPT], joinKeys(agreeing));
  check(
    'self-test: an agreeing fixture concept reports no divergence',
    agreeingResult.divergences.length === 0 && agreeingResult.comparisons === 4,
    `${agreeingResult.divergences.length} divergences across ${agreeingResult.comparisons} comparisons (2 concept languages + 2 join languages)`
  );

  // (i) A mangled value must be caught. This is the CLI-table mutation the
  // house guard sleeps through.
  const mangled = rivalTables(
    [['shared.label', "'甲'"]], [['shared.label', "'Alpha'"]],
    [['shared.label', "'乙'"]], [['shared.label', "'Alpha'"]]
  );
  const mangledFindings = findDivergences(mangled, [FIXTURE_CONCEPT], joinKeys(mangled)).divergences;
  check(
    'self-test: a mangled value is reported',
    mangledFindings.length === 2
      && mangledFindings.every((finding) => finding.concept.includes('fixture concept') || finding.concept.includes('shared.label')),
    mangledFindings.map((d) => `${d.concept}/${d.language}: ${show(d.left)} ≠ ${show(d.right)}`).join(', ') || 'not reported'
  );

  // (ii) A key that exists on only one side must drop out of the join rather
  // than manufacture a phantom divergence against `undefined` — and the
  // concept that needed it must be reported as missing.
  const absent = rivalTables(
    [['shared.label', "'甲'"]], [['shared.label', "'Alpha'"]],
    [['other.key', "'甲'"]], [['other.key', "'Alpha'"]]
  );
  const absentJoin = joinKeys(absent);
  const absentJoinFindings = findDivergences(absent, [], absentJoin).divergences;
  const absentConceptFindings = findDivergences(absent, [FIXTURE_CONCEPT], absentJoin).divergences;
  check(
    'self-test: a key removed from one table is reported',
    absentJoin.length === 0
      && absentJoinFindings.length === 0
      && absentConceptFindings.some((finding) => finding.missing && finding.concept === 'fixture concept'),
    `join groups=${absentJoin.length}, phantom=${absentJoinFindings.length}, missing-reported=${absentConceptFindings.filter((d) => d.missing).length}`
  );

  // A shared NAME whose VALUES agree must stay silent — the join is not a
  // rename detector, and reporting every equal pair would be noise.
  const sameName = rivalTables(
    [['status.idle', "'空闲'"]], [['status.idle', "'Idle'"]],
    [['status.idle', "'空闲'"]], [['status.idle', "'Idle'"]]
  );
  const sameNameFindings = findDivergences(sameName, [], joinKeys(sameName)).divergences;
  check(
    'self-test: a shared key name with equal values is not flagged',
    sameNameFindings.length === 0 && joinKeys(sameName).length === 1,
    `${sameNameFindings.length} findings across ${joinKeys(sameName).length} joined group`
  );

  // A shared NAME whose VALUES disagree in one language must be caught by the
  // join even though neither side renamed anything.
  const sameNameMangled = rivalTables(
    [['status.idle', "'空闲'"]], [['status.idle', "'Idle'"]],
    [['status.idle', "'闲置'"]], [['status.idle', "'Idle'"]]
  );
  const sameNameMangledFindings = findDivergences(sameNameMangled, [], joinKeys(sameNameMangled)).divergences;
  check(
    'self-test: a shared key name with a mangled value is flagged by the join',
    sameNameMangledFindings.length === 1
      && sameNameMangledFindings[0].language === 'zh'
      && sameNameMangledFindings[0].left === '空闲'
      && sameNameMangledFindings[0].right === '闲置',
    sameNameMangledFindings.map((d) => `${d.concept}/${d.language}: ${show(d.left)} ≠ ${show(d.right)}`).join(', ') || 'not reported'
  );

  // (ii) A key missing from one language must be caught by intra-table parity.
  const lopsided = fixtureTables('lopsidedDict',
    [['shared.label', "'甲'"], ['shared.copy', "'甲'"]],
    [['shared.label', "'Alpha'"]]
  );
  const zhKeys = [...lopsided.lopsidedDict.zh.map.keys()];
  const enKeys = new Set(lopsided.lopsidedDict.en.map.keys());
  const parityGaps = zhKeys.filter((key) => !enKeys.has(key));
  check(
    'self-test: a key missing from one language is reported',
    parityGaps.length === 1 && parityGaps[0] === 'shared.copy',
    parityGaps.join(', ') || 'not reported'
  );

  // (iii) A negative control: a key that legitimately differs across the two
  // tables, because nothing declares it a shared concept, must stay silent.
  const unrelated = rivalTables(
    [['shared.label', "'甲'"], ['shared.copy', "'甲'"], ['only.left', "'甲'"]],
    [['shared.label', "'Alpha'"], ['shared.copy', "'Alpha'"], ['only.left', "'Alpha'"]],
    [['shared.label', "'甲'"], ['shared.copy', "'甲'"], ['only.right', "'甲'"]],
    [['shared.label', "'Alpha'"], ['shared.copy', "'Alpha'"], ['only.right', "'Beta'"]]
  );
  const controlFindings = findDivergences(unrelated, [FIXTURE_CONCEPT], joinKeys(unrelated)).divergences;
  check(
    'self-test: a legitimately different key is not flagged',
    controlFindings.length === 0,
    controlFindings.map((d) => d.concept).join(', ') || 'silent (unrelated keys differ freely)'
  );

  // A duplicate key must be caught.
  const duplicated = fixtureTables('duplicatedDict',
    [['shared.label', "'甲'"], ['shared.copy', "'甲'"], ['shared.copy', "'甲'"]],
    [['shared.label', "'Alpha'"], ['shared.copy', "'Alpha'"]]
  );
  check(
    'self-test: a duplicate key is reported',
    duplicated.duplicatedDict.zh.duplicates.length === 1 && duplicated.duplicatedDict.zh.duplicates[0].key === 'shared.copy',
    duplicated.duplicatedDict.zh.duplicates.map((d) => `${d.key} (line ${d.line})`).join(', ') || 'not reported'
  );

  // The allowlist partition must route a recorded divergence to INFO and an
  // unrecorded one to FAIL. Driven through synthetic findings so the test
  // proves the DECISION, not merely that today's tree happens to diverge.
  const syntheticAllowlist = [
    { concept: 'recorded concept', language: 'en', left: { dict: 'a', key: 'k', value: 'x' }, right: { dict: 'b', key: 'k', value: 'y' }, reason: 'fixture reason' }
  ];
  const partition = routeDivergences(
    [
      { concept: 'recorded concept', language: 'en', left: 'x', right: 'y' },
      { concept: 'recorded concept', language: 'zh', left: 'x', right: 'z' },
      { concept: 'unrecorded concept', language: 'en', left: 'p', right: 'q' }
    ],
    syntheticAllowlist
  );
  check(
    'self-test: the allowlist routes a recorded divergence to INFO and everything else to FAIL',
    partition.passed.length === 1
      && partition.passed[0].divergence.language === 'en'
      && partition.failed.length === 2
      && partition.failed.some((divergence) => divergence.language === 'zh')
      && partition.failed.some((divergence) => divergence.concept === 'unrecorded concept'),
    `${partition.passed.length} allowlisted (${partition.passed.map((p) => `${p.divergence.concept}/${p.divergence.language}`).join(', ') || 'none'}), ${partition.failed.length} failed (${partition.failed.map((d) => `${d.concept}/${d.language}`).join(', ')})`
  );

  // The same partition against the REAL map: every allowlist entry must still
  // name a concept that exists and a language the concept is compared in, or
  // the entry is a dangling excuse that can never be matched.
  const dangling = ALLOWED_DIVERGENCES.filter((entry) => {
    const concept = SHARED_CONCEPTS.find((candidate) => candidate.concept === entry.concept);
    return !concept || !concept.languages.includes(entry.language);
  });
  check(
    'self-test: every allowlist entry names a real concept and language',
    dangling.length === 0,
    dangling.map((entry) => `${entry.concept}/${entry.language}`).join(', ') || `${ALLOWED_DIVERGENCES.length} entries all resolvable`
  );

  // (iv) The floor must fail when extraction finds nothing. This is the case
  // that would otherwise make every real check trivially green.
  const empty = fixtureTables('emptyDict', [], []);
  const emptyMetrics = { 'web zh keys': empty.emptyDict.zh.map.size, 'web en keys': empty.emptyDict.en.map.size };
  const emptyViolations = floorViolations({ ...Object.fromEntries(Object.keys(FLOORS).map((key) => [key, 0])), ...emptyMetrics });
  check(
    'self-test: an empty extraction fails the non-vacuity floor',
    emptyViolations.length > 0 && emptyViolations.some((violation) => violation.startsWith('web zh keys')),
    emptyViolations.slice(0, 2).join('; ')
  );

  // A value carrying a double-quoted apostrophe must decode, not vanish: the
  // real file has `"OpenAI's own endpoint, …"` and a single-quote-only matcher
  // reports those keys as missing from en.
  const apostrophe = fixtureTables('apostropheDict',
    [['brand.desc', "'甲'"]],
    [['brand.desc', `"OpenAI's own endpoint"`]]
  );
  check(
    'self-test: a double-quoted value containing an apostrophe is read',
    apostrophe.apostropheDict.en.map.get('brand.desc') === "OpenAI's own endpoint",
    show(apostrophe.apostropheDict.en.map.get('brand.desc'))
  );

  // The same for an escape: `\u3000` padding must survive into the comparison,
  // or the card labels would compare equal for the wrong reason.
  const escaped = fixtureTables('escapedDict',
    [['pad.label', "'状态：\\u3000\\u3000  '"]],
    [['pad.label', "'state:  '"]]
  );
  check(
    'self-test: an escaped padding character survives decoding',
    escaped.escapedDict.zh.map.get('pad.label') === '状态：\u3000\u3000  ',
    show(escaped.escapedDict.zh.map.get('pad.label'))
  );

  // The reported line must distinguish the two values even when they are long
  // and differ only near the end. A truncating printer renders two different
  // ~100-character strings identically, so a FAIL would name a difference the
  // reader cannot see — the same class of defect as a green check that hides a
  // real divergence.
  const longCommon = 'SuperIU · a product description that runs on and on and on and on until it passes one hundred characters in total';
  const leftLong = `${longCommon} alpha`;
  const rightLong = `${longCommon} omega`;
  const rendered = showDiff(leftLong, rightLong);
  const [shownLeft, shownRight] = rendered.split(' ≠ ');
  check(
    'self-test: the difference reporter distinguishes long values that differ at the end',
    shownLeft !== shownRight && shownLeft.includes('alpha') && shownRight.includes('omega'),
    rendered
  );
  check(
    'self-test: a short pair is still printed in full',
    showDiff('空闲', '闲置') === '"空闲" ≠ "闲置"',
    showDiff('空闲', '闲置')
  );
  check(
    'self-test: the difference reporter identifies where a same-length pair diverges',
    showDiff(`${longCommon} alpha`, `${longCommon} alphb`).includes('first difference at character'),
    showDiff(`${longCommon} alpha`, `${longCommon} alphb`)
  );

  // --- check class B: core enum -> CLI word map ----------------------------
  //
  // Same principle as above: these drive the REAL parse (parseUnionValues ->
  // readWordMap -> inspectWordMapEntry -> routeWordMapGaps), against synthetic
  // sources, so the case proves the detector can fail rather than that today's
  // tree happens to be clean.

  /** A synthetic core file declaring `export type <name> = 'a' | 'b';`. */
  const fixtureUnion = (name, values) => `export type ${name} =\n${values.map((value) => `  | '${value}'`).join('\n')};\n`;
  /** A synthetic core file declaring only the inline property union. */
  const fixtureInlineUnion = (name, values) => `export interface Fixture {\n  ${name}: ${values.map((value) => `'${value}'`).join(' | ')};\n}\n`;
  /** A synthetic CLI file declaring `<mapName>: Record<string, string> = { … }`. */
  const fixtureMap = (mapName, pairs) =>
    `  const ${mapName}: Record<string, string> = {\n${pairs.map(([key, key2]) => `    ${key}: '${key2}',`).join('\n')}\n  };\n`;
  /** A whole synthetic CLI source: the map plus one unrelated map, so the scan
   * for a covering map is exercised against noise rather than alone. */
  const fixtureMapSource = (mapName, pairs) => `export function f() {\n${fixtureMap(mapName, pairs)}\n${fixtureMap('unrelatedKeys', [['other', 'k']])}\n}\n`;

  // (v) A value present in the union but absent from the map is CAUGHT, and the
  // failure names the value — the load-bearing case for this whole check class.
  const missingValue = inspectWordMapEntry(
    { id: 'RiskLevel', union: 'RiskLevel', map: 'riskWordKeys' },
    fixtureUnion('RiskLevel', ['safe', 'low', 'critical']),
    fixtureMapSource('riskWordKeys', [['safe', 'k'], ['low', 'k']])
  );
  const missingValueRouted = routeWordMapGaps([missingValue], []);
  check(
    'self-test: an enum value with no word in the map is caught and named',
    missingValue.missing.length === 1 && missingValue.missing[0] === 'critical' && missingValueRouted.failed.length === 1,
    `missing=${missingValue.missing.join(', ') || 'none'}, routed to ${missingValueRouted.failed.length} FAIL`
  );

  // (vi) Negative control: a FULLY mapped union must stay silent, so the check
  // reports a real gap rather than every enum it is pointed at. The map carries
  // an extra key too — an unused entry is not a gap.
  const fullyMapped = inspectWordMapEntry(
    { id: 'RiskLevel', union: 'RiskLevel', map: 'riskWordKeys' },
    fixtureUnion('RiskLevel', ['safe', 'low']),
    fixtureMapSource('riskWordKeys', [['safe', 'k'], ['low', 'k'], ['unused', 'k']])
  );
  check(
    'self-test: a fully mapped enum is not flagged',
    fullyMapped.missing.length === 0 && routeWordMapGaps([fullyMapped], []).failed.length === 0,
    `${fullyMapped.values.length} values, ${fullyMapped.mapKeys.length} map keys, 0 missing`
  );

  // (vii) The inline property union (core's `reviewedBy: 'rule' | 'model'`) must
  // parse. If the alias-only matcher from §4 were reused unchanged this entry
  // would read as ZERO values and vacantly pass.
  const inlineParsed = parseUnionValues(fixtureInlineUnion('reviewedBy', ['rule', 'model']), 'reviewedBy');
  check(
    'self-test: an inline property union parses its values',
    inlineParsed.length === 2 && inlineParsed.join(',') === 'rule,model',
    inlineParsed.join(', ') || 'no values parsed'
  );

  // (viii) A property that is NOT a union (`reviewedBy: ReviewSource`) must not
  // be read as one — a false positive here would invent values to map.
  const nonUnion = parseUnionValues('export interface Fixture {\n  reviewedBy: ReviewSource;\n}\n', 'reviewedBy');
  check(
    'self-test: a non-union property is not read as a union',
    nonUnion.length === 0,
    nonUnion.join(', ') || 'no values (correctly rejected)'
  );

  // (ix) NO-VACUITY: a union parse yielding zero values must fail, not pass.
  const vacuous = inspectWordMapEntry(
    { id: 'RiskLevel', union: 'Renamed', map: 'riskWordKeys' },
    fixtureUnion('RiskLevel', ['safe', 'low']),
    fixtureMapSource('riskWordKeys', [['safe', 'k'], ['low', 'k']])
  );
  const vacuousFloor = floorViolations({ 'enum union values': 0, 'enum word map keys': 2 });
  check(
    'self-test: an empty union parse fails instead of passing',
    vacuous.values.length === 0 && vacuous.missing.length === 0 && vacuousFloor.some((v) => v.startsWith('enum union values')),
    `values=${vacuous.values.length}, floor violations: ${vacuousFloor.join('; ')}`
  );

  // (x) A renamed/absent map must FAIL rather than read as "nothing mapped".
  const absentMap = inspectWordMapEntry(
    { id: 'RiskLevel', union: 'RiskLevel', map: 'goneWordKeys' },
    fixtureUnion('RiskLevel', ['safe', 'low']),
    fixtureMapSource('riskWordKeys', [['safe', 'k'], ['low', 'k']])
  );
  check(
    'self-test: a missing word map declaration is reported',
    Boolean(absentMap.mapError) && absentMap.missing.length === 0,
    absentMap.mapError ?? 'not reported'
  );

  // (xi) The word-map allowlist partition: exact values -> INFO, a grown gap or
  // an unrecorded enum -> FAIL. Same contract as routeDivergences, and the same
  // reason for proving it against synthetic findings.
  //
  // Note the map is PINNED here on purpose. Only a pinned map's gap may be
  // excused, because a `map: null` gap is the one measurement that cannot tell an
  // emptied map from a missing one — see the `null` case directly below.
  const fixtureAllowlist = [{ id: 'AutoReviewMode', values: ['lenient'], reason: 'fixture reason' }];
  const pinched = routeWordMapGaps(
    [
      inspectWordMapEntry({ id: 'AutoReviewMode', union: 'AutoReviewMode', map: 'modeWordKeys' },
        fixtureUnion('AutoReviewMode', ['lenient', 'strict']), fixtureMapSource('modeWordKeys', [['strict', 'k']])),
      inspectWordMapEntry({ id: 'AutoReviewMode', union: 'AutoReviewMode', map: 'modeWordKeys' },
        fixtureUnion('AutoReviewMode', ['lenient', 'strict', 'paranoid']), fixtureMapSource('modeWordKeys', [['strict', 'k']]))
    ],
    fixtureAllowlist
  );
  check(
    'self-test: the word-map allowlist pins EXACT values and a grown gap fails',
    pinched.passed.length === 1 && pinched.failed.length === 1 && pinched.failed[0].missing.length === 2,
    `${pinched.passed.length} allowlisted, ${pinched.failed.length} failed (missing ${pinched.failed[0]?.missing.join(', ')})`
  );

  // (xi-b) The counterpart: a `map: null` gap is NEVER excusable, even when an
  // allowlist entry pins exactly its missing values. Pinning the values is not
  // enough there — the same measurement also describes "the map was never added",
  // so an entry that matched would absorb an emptied map and go green. The fix is
  // to pin the map's name, which is what makes the two states separable.
  const nullPinAttempt = routeWordMapGaps(
    [inspectWordMapEntry({ id: 'AutoReviewMode', union: 'AutoReviewMode', map: null },
      fixtureUnion('AutoReviewMode', ['lenient', 'strict']), fixtureMapSource('otherKeys', [['x', 'k']]))],
    [{ id: 'AutoReviewMode', values: ['lenient', 'strict'], reason: 'fixture absorbing pin' }]
  );
  check(
    'self-test: an unpinned (map: null) gap is never excused by the allowlist',
    nullPinAttempt.passed.length === 0 && nullPinAttempt.failed.length === 1,
    `${nullPinAttempt.passed.length} allowlisted / ${nullPinAttempt.failed.length} failed (a pin can never match \`map: null\`)`
  );

  // (xii) A stale allowlist entry: once a map covers every value the gap is gone
  // and the entry must be reported as stale, not matched silently. Driven with
  // no declared map — the entry's own `map: null` case — so the covering-map scan
  // is what detects the fix, which is how a future `autoReviewModeWordKeys` map
  // (whatever it is named) will retire the entry.
  const cured = inspectWordMapEntry(
    { id: 'AutoReviewMode', union: 'AutoReviewMode', map: null },
    fixtureUnion('AutoReviewMode', ['lenient', 'strict']),
    fixtureMapSource('autoReviewModeWordKeys', [['lenient', 'k'], ['strict', 'k']])
  );
  check(
    'self-test: a cured unmapped enum reports no gap (allowlist entry goes stale)',
    cured.missing.length === 0 && cured.coveringMap === 'autoReviewModeWordKeys',
    `coveringMap=${cured.coveringMap ?? 'none'}, missing=${cured.missing.join(', ') || 'none'}`
  );

  // (xiii) A HALF-DONE fix — a map added for one value of a union whose entry
  // pins no map — must be measured as a partial gap, not as "nothing mapped".
  // The two read differently to the allowlist: a full-union pin absorbs
  // "nothing mapped", so scoring a partial map as zero would let a botched fix
  // route to INFO and pass. This case is the regression test for that.
  const halfDone = inspectWordMapEntry(
    { id: 'AutoReviewMode', union: 'AutoReviewMode', map: null },
    fixtureUnion('AutoReviewMode', ['lenient', 'strict']),
    fixtureMapSource('modeWordKeys', [['lenient', 'k']])
  );
  const halfDoneRouted = routeWordMapGaps([halfDone], [{ id: 'AutoReviewMode', values: ['lenient', 'strict'], reason: 'r' }]);
  check(
    'self-test: a partially mapped enum is a FAIL, not an absorbed gap',
    halfDone.missing.length === 1 && halfDone.missing[0] === 'strict' && halfDoneRouted.failed.length === 1,
    `mapped ${halfDone.values.length - halfDone.missing.length}/${halfDone.values.length} via ${halfDone.coveringMap}, missing=${halfDone.missing.join(', ')}, routed to ${halfDoneRouted.failed.length} FAIL`
  );

  // (xiv) THE EMPTIED MAP. A PINNED map that exists but declares no keys must
  // FAIL — not be reported as a gap, because a gap is exactly what "the map was
  // never added" looks like, and that is the state an allowlist entry is written
  // to excuse. This is the case the whole hardened path exists for: before it was
  // covered, `{}` in place of the real body produced the same measurement as
  // "never mapped" and a matching pin routed it to INFO, so the guard stayed green
  // through a deleted translation table. The negative control follows immediately:
  // the SAME fixture with keys present must NOT be flagged.
  const emptiedPinned = inspectWordMapEntry(
    { id: 'AutoReviewMode', union: 'AutoReviewMode', map: 'modeWordKeys' },
    fixtureUnion('AutoReviewMode', ['lenient', 'strict']),
    fixtureMapSource('modeWordKeys', [])
  );
  const emptiedRouted = routeWordMapGaps([emptiedPinned], [{ id: 'AutoReviewMode', values: ['lenient', 'strict'], reason: 'r' }]);
  check(
    'self-test: a pinned map that exists but is empty is a FAIL, not an absorbed gap',
    emptiedPinned.mapKeys.length === 0
      && !emptiedPinned.mapError
      && emptiedPinned.missing.length === 2
      && emptiedRouted.passed.length === 0
      && emptiedRouted.failed.length === 1
      && emptiedRouted.failed[0].vacuousPinnedMap === true,
    `mapKeys=${emptiedPinned.mapKeys.length}, mapError=${emptiedPinned.mapError ?? 'none'}, missing=${emptiedPinned.missing.join(', ') || 'none'}, ${emptiedRouted.passed.length} allowlisted / ${emptiedRouted.failed.length} failed`
  );
  const emptiedMessage = vacuousPinnedMapMessage(
    { union: 'AutoReviewMode', render: 'fixture render site' },
    emptiedPinned
  );
  check(
    'self-test: the empty-map failure names the entry and the map',
    Boolean(emptiedMessage) && emptiedMessage.includes('modeWordKeys') && emptiedMessage.includes('ZERO keys') && emptiedMessage.includes('AutoReviewMode'),
    emptiedMessage ?? 'no message'
  );

  // (xv) Negative control for (xiv): the same fixture with full coverage is NOT
  // flagged, so the empty check reports a real defect rather than every pinned map.
  const stockedPinned = inspectWordMapEntry(
    { id: 'AutoReviewMode', union: 'AutoReviewMode', map: 'modeWordKeys' },
    fixtureUnion('AutoReviewMode', ['lenient', 'strict']),
    fixtureMapSource('modeWordKeys', [['lenient', 'k'], ['strict', 'k']])
  );
  const stockedRouted = routeWordMapGaps([stockedPinned], []);
  check(
    'self-test: a fully covered pinned map is not flagged as empty',
    stockedPinned.mapKeys.length === 2
      && vacuousPinnedMapMessage({ union: 'AutoReviewMode', render: 'r' }, stockedPinned) === null
      && stockedRouted.failed.length === 0,
    `${stockedPinned.mapKeys.length} keys, 0 missing, ${stockedRouted.failed.length} failed`
  );

  // (xvi) The gap PROSE must name the covering map and the specific missing
  // value(s) — never claim "no word map covers" while a partially covering map
  // exists, which hides which map needs the key and which single value is absent.
  const partialPinned = inspectWordMapEntry(
    { id: 'AutoReviewMode', union: 'AutoReviewMode', map: 'modeWordKeys' },
    fixtureUnion('AutoReviewMode', ['lenient', 'strict']),
    fixtureMapSource('modeWordKeys', [['lenient', 'k']])
  );
  const partialProse = wordMapGapMessage(
    { union: 'AutoReviewMode', render: 'fixture render site' },
    partialPinned
  );
  check(
    'self-test: a partial gap names the covering map and the missing value',
    partialProse.includes('modeWordKeys') && partialProse.includes('strict') && !partialProse.includes('no word map covers'),
    partialProse
  );

  // (xvii) The other half of (xvi): when genuinely NOTHING covers a value the
  // prose must say so, so the "no word map covers" wording is reserved for its one
  // true state rather than deleted along with the misleading use.
  const uncovered = inspectWordMapEntry(
    { id: 'AutoReviewMode', union: 'AutoReviewMode', map: null },
    fixtureUnion('AutoReviewMode', ['lenient', 'strict']),
    fixtureMapSource('unrelatedKeys', [['x', 'k']])
  );
  const uncoveredProse = wordMapGapMessage(
    { union: 'AutoReviewMode', render: 'fixture render site' },
    uncovered
  );
  check(
    'self-test: a completely uncovered union still says no word map covers it',
    uncovered.coveringMap === null && uncoveredProse.includes('no word map covers') && uncoveredProse.includes('lenient, strict'),
    uncoveredProse
  );

  // --- check class B, web side: the SPA's function-local maps ----------------
  //
  // The SPA declares its maps as a function-local `const keys = { … }`, and three
  // functions in `packages/ui/public/index.html` declare one. So the reader is
  // driven here against a synthetic source with SEVERAL such functions: without
  // that, a case could pass while the reader was actually returning whichever
  // literal happened to come first in the file — the exact way a deleted map would
  // read as "still there".

  /** A synthetic SPA source with one function holding a local `const keys`. */
  const fixtureFunctionMapSource = (functionName, pairs) =>
    `function ${functionName}(value) {\n  const keys = {\n${pairs.map(([key, target]) => `    ${key}: '${target}',`).join('\n')}\n  };\n  return tr(keys[value] ?? 'approval.risk.unknown');\n}\n`;

  /** Two functions, each with its OWN `keys`, so the anchor is what selects. */
  const decoySource =
    fixtureFunctionMapSource('reviewerLabel', [['rule', 'approval.reviewer.rule']]) +
    fixtureFunctionMapSource('riskLabel', [['safe', 'approval.risk.safe'], ['high', 'approval.risk.high']]);

  // (xviii) The reader finds the map inside the NAMED function, not the first
  // `const keys` in the file — the decoy `reviewerLabel` comes first on purpose.
  const anchored = readFunctionScopedMap(decoySource, 'riskLabel', 'keys');
  check(
    'self-test: a function-scoped map is read from the named function, not the first literal',
    anchored.error === undefined && anchored.keys.join(',') === 'safe,high',
    anchored.error ?? `keys=${anchored.keys.join(', ')}`
  );

  // (xix) NO-VACUITY: a renamed function is an error, not an empty read. A silent
  // empty read would look exactly like "the map was never added".
  const renamedFunction = readFunctionScopedMap(decoySource, 'riskWordLabel', 'keys');
  check(
    'self-test: a renamed function anchor is reported, not read as empty',
    Boolean(renamedFunction.error) && renamedFunction.error.includes('function not found'),
    renamedFunction.error ?? 'not reported'
  );

  // (xx) THE DELETED MAP, the headline web escape. `riskLabel` no longer declares
  // a map, but `reviewerLabel` still declares one — so a reader that searched for
  // `const keys` without bounding the body would find the reviewer's map and report
  // the risk enum as covered. It must instead be an error.
  const deletedFromFunction = readFunctionScopedMap(
    fixtureFunctionMapSource('reviewerLabel', [['rule', 'approval.reviewer.rule']]) + 'function riskLabel(risk) {\n  return tr(risk);\n}\n',
    'riskLabel',
    'keys'
  );
  check(
    'self-test: a map deleted from the named function is an error even when a sibling declares one',
    Boolean(deletedFromFunction.error) && deletedFromFunction.error.includes('not found inside function riskLabel()'),
    deletedFromFunction.error ?? `not reported (keys=${deletedFromFunction.keys?.join(', ')})`
  );

  // (xxi) An EMPTIED map inside the named function is zero keys, NOT an error — the
  // same "never added" vs "emptied" distinction the CLI reader draws, so the pinned
  // map's zero-key FAIL can fire rather than being swallowed as a parse error.
  const emptiedFunctionMap = readFunctionScopedMap(fixtureFunctionMapSource('riskLabel', []), 'riskLabel', 'keys');
  check(
    'self-test: an emptied function-scoped map reads as zero keys, not as an error',
    emptiedFunctionMap.error === undefined && emptiedFunctionMap.keys.length === 0,
    emptiedFunctionMap.error ?? `keys=${emptiedFunctionMap.keys.length}`
  );

  // (xxii) The body bound must skip braces inside strings. `riskLabel` sits next to
  // functions whose bodies carry `{ name: … }` argument objects and `${…}`
  // templates; counting braces blindly would end the body early and read the wrong
  // region.
  const bracesInStrings = readFunctionScopedMap(
    `function riskLabel(risk) {\n  const label = '{ not a brace }';\n  const keys = {\n    safe: 'approval.risk.safe'\n  };\n  return tr(keys[risk] ?? 'approval.risk.unknown', { name: label });\n}\n`,
    'riskLabel',
    'keys'
  );
  check(
    'self-test: braces inside strings do not end the function body early',
    bracesInStrings.error === undefined && bracesInStrings.keys.join(',') === 'safe',
    bracesInStrings.error ?? `keys=${bracesInStrings.keys.join(', ')}`
  );

  // --- check class B, §5b: the ROUTING axes ---------------------------------

  const routingUnion = fixtureUnion('RiskLevel', ['safe', 'low', 'high']);
  const routingTables = {
    ...fixtureTables('webDict',
      [['approval.risk.safe', "'安全'"], ['approval.risk.low', "'低'"], ['approval.risk.high', "'高'"], ['approval.risk.other', "'其他'"]],
      [['approval.risk.safe', "'safe'"], ['approval.risk.low', "'low'"], ['approval.risk.high', "'high'"], ['approval.risk.other', "'other'"]]
    ),
    ...fixtureTables('cliDict',
      [['cli.approval.riskSafe', "'安全'"], ['cli.approval.riskLow', "'低'"], ['cli.approval.riskHigh', "'高'"], ['cli.approval.riskOther', "'其他'"]],
      [['cli.approval.riskSafe', "'safe'"], ['cli.approval.riskLow', "'low'"], ['cli.approval.riskHigh', "'high'"], ['cli.approval.riskOther', "'other'"]]
    )
  };
  /** The pairing `SHARED_CONCEPTS` records for these levels on the real tree. */
  const routingConcepts = [
    ['safe', 'riskSafe'],
    ['low', 'riskLow'],
    ['high', 'riskHigh']
  ].map(([level, cliKey]) => ({
    concept: `risk level [${level}]`,
    left: { dict: 'webDict', key: `approval.risk.${level}` },
    right: { dict: 'cliDict', key: `cli.approval.${cliKey}` },
    languages: LANGUAGES
  }));
  /** One arm of the real tree, read end to end through the real readers. */
  const routingArm = (cliPairs, webPairs) => ({
    inspection: inspectWordMapEntry(
      { id: 'RiskLevel', union: 'RiskLevel', map: 'riskWordKeys', shell: 'cli', mapLabel: 'riskWordKeys' },
      routingUnion,
      fixtureMapSource('riskWordKeys', cliPairs)
    ),
    webInspection: inspectWordMapEntry(
      { id: 'RiskLevel@web', union: 'RiskLevel', map: 'keys', function: 'riskLabel', shell: 'web', mapLabel: 'keys (in riskLabel())' },
      routingUnion,
      fixtureFunctionMapSource('riskLabel', webPairs)
    )
  });

  // (xxiii) The MISPRINT case: a target renamed to a key no dictionary defines.
  // Coverage is still complete, which is why only a target-existence check sees it.
  const missingTargetArm = routingArm(
    [['safe', 'cli.approval.riskSafe'], ['low', 'cli.approval.riskLow'], ['high', 'cli.approval.riskNope']],
    [['safe', 'approval.risk.safe'], ['low', 'approval.risk.low'], ['high', 'approval.risk.high']]
  );
  const missingTargetFindings = wordMapRoutingFindings({
    ...missingTargetArm,
    dictionary: 'cliDict',
    webDictionary: 'webDict',
    tables: routingTables,
    sharedConcepts: routingConcepts
  });
  check(
    'self-test: a word-map target that is not a defined dictionary key is caught',
    missingTargetFindings.undefinedTargets.length === 1
      && missingTargetFindings.undefinedTargets[0].key === 'high'
      && missingTargetFindings.undefinedTargets[0].value === 'cli.approval.riskNope',
    missingTargetFindings.undefinedTargets.map((pair) => `${pair.key} -> ${pair.value}`).join(', ') || 'not reported'
  );

  // (xxiv) Two values pointing at ONE word: every value is still "mapped", so only
  // this axis sees that two different risks render identically.
  const sharedTargetArm = routingArm(
    [['safe', 'cli.approval.riskSafe'], ['low', 'cli.approval.riskSafe'], ['high', 'cli.approval.riskHigh']],
    [['safe', 'approval.risk.safe'], ['low', 'approval.risk.safe'], ['high', 'approval.risk.high']]
  );
  const sharedTargetFindings = wordMapRoutingFindings({
    ...sharedTargetArm,
    dictionary: 'cliDict',
    webDictionary: 'webDict',
    tables: routingTables,
    sharedConcepts: routingConcepts
  });
  check(
    'self-test: two values sharing one word-map target is caught',
    sharedTargetFindings.sharedTargets.length === 1
      && sharedTargetFindings.sharedTargets[0][0] === 'cli.approval.riskSafe'
      && sharedTargetFindings.sharedTargets[0][1].join(',') === 'safe,low',
    sharedTargetFindings.sharedTargets.map(([value, keys]) => `${keys.join(' + ')} -> ${value}`).join(', ') || 'not reported'
  );

  // (xxv) THE HEADLINE MIS-ROUTE, in the shape the adversarial proof used:
  // `riskWordKeys.high -> 'cli.approval.riskLow'`. The target EXISTS and no other
  // value shares it (so neither of the two axes above fires), yet `high` now renders
  // `low`'s word — complete-but-wrong coverage that only the pairing check catches,
  // because no recorded concept pairs `approval.risk.high` with `cli.approval.riskLow`.
  const misroutedArm = routingArm(
    [['safe', 'cli.approval.riskSafe'], ['low', 'cli.approval.riskLow'], ['high', 'cli.approval.riskLow']],
    [['safe', 'approval.risk.safe'], ['low', 'approval.risk.low'], ['high', 'approval.risk.high']]
  );
  const misroutedFindings = wordMapRoutingFindings({
    ...misroutedArm,
    dictionary: 'cliDict',
    webDictionary: 'webDict',
    tables: routingTables,
    sharedConcepts: routingConcepts
  });
  check(
    'self-test: a value routed to a word no recorded concept pairs with the web target is caught',
    misroutedFindings.misrouted.length === 1
      && misroutedFindings.misrouted[0].includes('high')
      && misroutedFindings.misrouted[0].includes('cli.approval.riskLow')
      && misroutedFindings.misrouted[0].includes("word of `low`"),
    misroutedFindings.misrouted.join(', ') || 'not reported'
  );

  // (xxvi) The mis-route axis in ISOLATION: the target is defined and mentioned by
  // no other value, so the two other axes stay silent and only the pairing check can
  // see it. This is the case that proves (xxv) was not caught by the shared-target
  // axis happening to fire as well.
  const unpairedArm = routingArm(
    [['safe', 'cli.approval.riskSafe'], ['low', 'cli.approval.riskOther'], ['high', 'cli.approval.riskHigh']],
    [['safe', 'approval.risk.safe'], ['low', 'approval.risk.low'], ['high', 'approval.risk.high']]
  );
  const unpairedFindings = wordMapRoutingFindings({
    ...unpairedArm,
    dictionary: 'cliDict',
    webDictionary: 'webDict',
    tables: routingTables,
    sharedConcepts: routingConcepts
  });
  check(
    'self-test: the mis-route axis fires alone when the target is defined and unshared',
    unpairedFindings.undefinedTargets.length === 0
      && unpairedFindings.sharedTargets.length === 0
      && unpairedFindings.misrouted.length === 1
      && unpairedFindings.misrouted[0].includes('no recorded pairing for this pair'),
    `undefined=${unpairedFindings.undefinedTargets.length}, shared=${unpairedFindings.sharedTargets.length}, misrouted=${unpairedFindings.misrouted.join(', ') || 'none'}`
  );

  // (xxvii) Negative control for all three axes: the correctly paired, defined,
  // distinct map reports NOTHING. Without this the routing check would only prove it
  // can complain, not that it can stay silent on a healthy tree — which is what
  // keeps it from forcing an allowlist entry for the real maps.
  const healthyArm = routingArm(
    [['safe', 'cli.approval.riskSafe'], ['low', 'cli.approval.riskLow'], ['high', 'cli.approval.riskHigh']],
    [['safe', 'approval.risk.safe'], ['low', 'approval.risk.low'], ['high', 'approval.risk.high']]
  );
  const healthyFindings = wordMapRoutingFindings({
    ...healthyArm,
    dictionary: 'cliDict',
    webDictionary: 'webDict',
    tables: routingTables,
    sharedConcepts: routingConcepts
  });
  check(
    'self-test: a correctly paired word map reports no routing finding',
    healthyFindings.undefinedTargets.length === 0
      && healthyFindings.sharedTargets.length === 0
      && healthyFindings.misrouted.length === 0,
    `${healthyArm.inspection.mapKeys.length} cli keys, ${healthyArm.webInspection.mapKeys.length} web keys, 0 findings on all three axes`
  );

  // (xxviii) NO-VACUITY for the web arm: the routing check reads a map out of a
  // FUNCTION, so a renamed anchor must FAIL rather than leave the arm silently
  // skipped. This drives the real `readFunctionScopedMap` through the same
  // `inspectWordMapEntry` the run uses.
  const renamedWebAnchor = inspectWordMapEntry(
    { id: 'RiskLevel@web', union: 'RiskLevel', map: 'keys', function: 'riskWordLabel', shell: 'web', mapLabel: 'keys (in riskWordLabel())' },
    routingUnion,
    fixtureFunctionMapSource('riskLabel', [['safe', 'approval.risk.safe']])
  );
  check(
    'self-test: a renamed web map anchor is a FAIL, not a skipped arm',
    Boolean(renamedWebAnchor.mapError) && renamedWebAnchor.mapKeys.length === 0,
    renamedWebAnchor.mapError ?? 'not reported'
  );

  // (xxix) A map moved OUT of the named function (into a sibling) must also FAIL:
  // the anchor is the function, so a file-scope literal no longer satisfies it.
  const movedOutOfFunction = inspectWordMapEntry(
    { id: 'RiskLevel@web', union: 'RiskLevel', map: 'keys', function: 'riskLabel', shell: 'web', mapLabel: 'keys (in riskLabel())' },
    routingUnion,
    `const keys = {\n  safe: 'approval.risk.safe'\n};\nfunction riskLabel(risk) {\n  return tr(keys[risk]);\n}\n`
  );
  check(
    'self-test: a web map moved out of its function is a FAIL',
    Boolean(movedOutOfFunction.mapError) && movedOutOfFunction.mapError.includes('not found inside function riskLabel()'),
    movedOutOfFunction.mapError ?? 'not reported'
  );

  // (xxx) The render site's SECOND key string — the `?? '…'` fallback — is read
  // from the site rather than hardcoded. This is the key an unrecognised value from
  // a newer core renders, so renaming it to an undefined key prints a raw key for
  // exactly the values the fallback exists to cover.
  const readFallback = inspectWordMapEntry(
    { id: 'RiskLevel@web', union: 'RiskLevel', map: 'keys', function: 'riskLabel', shell: 'web', mapLabel: 'keys (in riskLabel())' },
    routingUnion,
    fixtureFunctionMapSource('riskLabel', [['safe', 'approval.risk.safe']])
  );
  check(
    'self-test: the render site\'s ?? fallback key is read, not assumed',
    readFallback.fallbackKey === 'approval.risk.unknown',
    `fallbackKey=${JSON.stringify(readFallback.fallbackKey)}`
  );

  // (xxxi) A renamed fallback that no dictionary defines must FAIL, so the key the
  // site prints on a miss cannot rot unnoticed. Driven with a fallback absent from
  // the fixture dictionary.
  const renamedFallback = inspectWordMapEntry(
    { id: 'RiskLevel@web', union: 'RiskLevel', map: 'keys', function: 'riskLabel', shell: 'web', mapLabel: 'keys (in riskLabel())' },
    routingUnion,
    `function riskLabel(risk) {\n  const keys = {\n    safe: 'approval.risk.safe'\n  };\n  return tr(keys[risk] ?? 'approval.risk.gone');\n}\n`
  );
  const renamedFallbackDefined = routingTables.webDict.zh.map.has(renamedFallback.fallbackKey)
    && routingTables.webDict.en.map.has(renamedFallback.fallbackKey);
  check(
    'self-test: a renamed fallback key that the dictionary does not define is caught',
    renamedFallback.fallbackKey === 'approval.risk.gone' && !renamedFallbackDefined,
    `fallbackKey=${JSON.stringify(renamedFallback.fallbackKey)}, defined=${renamedFallbackDefined}`
  );

  // (xxxii) Negative control: the REAL fallback key IS defined, so the check above
  // reports a real defect rather than flagging every render site.
  const healthyFallbackDefined = routingTables.webDict.zh.map.has('approval.risk.other')
    && routingTables.webDict.en.map.has('approval.risk.other');
  check(
    'self-test: a defined fallback key is not flagged',
    healthyFallbackDefined,
    `'approval.risk.other' defined in the fixture web dictionary = ${healthyFallbackDefined}`
  );

  // (xxxiii) A body with NO `??` fallback reads as `null` rather than throwing or
  // inventing a key — the state the runner treats as "this site has no fallback".
  const noFallback = inspectWordMapEntry(
    { id: 'RiskLevel@web', union: 'RiskLevel', map: 'keys', function: 'riskLabel', shell: 'web', mapLabel: 'keys (in riskLabel())' },
    routingUnion,
    `function riskLabel(risk) {\n  const keys = {\n    safe: 'approval.risk.safe'\n  };\n  return tr(keys[risk]);\n}\n`
  );
  check(
    'self-test: a render site with no ?? fallback reads as null',
    noFallback.fallbackKey === null && noFallback.error === undefined,
    `fallbackKey=${JSON.stringify(noFallback.fallbackKey)}`
  );

  // (xxxiv) The CLI fallback is read from the INDEXED use, not the declaration, so
  // the anchor is the render site. A map whose declaration is present but whose
  // render site lost its `??` must read as null rather than snapping to an unrelated
  // `??` elsewhere in the file.
  const cliFallback = inspectWordMapEntry(
    { id: 'RiskLevel', union: 'RiskLevel', map: 'riskWordKeys', shell: 'cli', mapLabel: 'riskWordKeys' },
    routingUnion,
    `function f() {\n  const riskWordKeys: Record<string, string> = {\n    safe: 'cli.approval.riskSafe'\n  };\n  return tr(riskWordKeys[x] ?? 'cli.approval.riskUnknown');\n}\n`
  );
  check(
    'self-test: the cli fallback key is read from the indexed render site',
    cliFallback.fallbackKey === 'cli.approval.riskUnknown',
    `fallbackKey=${JSON.stringify(cliFallback.fallbackKey)}`
  );

  // --- the readers must not be fooled by DECOYS ------------------------------
  //
  // Every case below was a REAL silent false negative: the previous readers located
  // their target with a plain `indexOf` over raw text, so a decoy that merely
  // MENTIONS the map was read in place of the real declaration, and the guard
  // reported complete coverage while the render site held a different (or no) map.
  // Each case is driven through the real `readFunctionScopedMap` / `readWordMap` /
  // `inspectWordMapEntry` the run uses, and each asserts BOTH that the decoy is not
  // what was read AND that the real declaration is.

  /** The correct 5-level map, as the SPA writes it, for the decoy cases below. */
  const REAL_WEB_MAP = [['safe', 'approval.risk.safe'], ['low', 'approval.risk.low'], ['high', 'approval.risk.high']];
  /** A whole function whose body holds `extra` before the real map. */
  const webWithPrefix = (extra) =>
    `function riskLabel(risk) {\n${extra}  const keys = {\n${REAL_WEB_MAP.map(([key, target]) => `    ${key}: '${target}',`).join('\n')}\n  };\n  return tr(keys[risk] ?? 'approval.risk.unknown');\n}\n`;

  // (xxxv) A STRING LITERAL that mentions the map, declared before the real one.
  // `indexOf('const keys')` landed inside this string and read the decoy's keys, so
  // a mislabeled real map was reported as complete — and with the real map DELETED
  // the guard still reported "declares 5 keys" for a function whose `keys` is
  // `undefined` at runtime.
  const stringDecoy = webWithPrefix(
    `  const hint = "const keys = { safe: 'approval.risk.safe', low: 'approval.risk.low', high: 'approval.risk.low' };";\n`
  );
  const stringDecoyRead = readFunctionScopedMap(stringDecoy, 'riskLabel', 'keys');
  check(
    'self-test: a string literal that mentions the map is not read as the declaration',
    stringDecoyRead.error === undefined
      && stringDecoyRead.keys.join(',') === 'safe,low,high'
      && stringDecoyRead.fallbackKey === 'approval.risk.unknown',
    stringDecoyRead.error ?? `keys=${stringDecoyRead.keys.join(', ')} (the decoy would have read safe,low,low)`
  );

  // (xxxvi) The same shape as a `//` line comment.
  const lineCommentDecoy = webWithPrefix(
    `  // const keys = { safe: 'approval.risk.safe', low: 'approval.risk.low', high: 'approval.risk.low' };\n`
  );
  const lineCommentRead = readFunctionScopedMap(lineCommentDecoy, 'riskLabel', 'keys');
  check(
    'self-test: a // comment that mentions the map is not read as the declaration',
    lineCommentRead.error === undefined && lineCommentRead.keys.join(',') === 'safe,low,high',
    lineCommentRead.error ?? `keys=${lineCommentRead.keys.join(', ')}`
  );

  // (xxxvii) And as a `/* … */` block comment.
  const blockCommentDecoy = webWithPrefix(
    `  /* const keys = { safe: 'approval.risk.safe', low: 'approval.risk.low', high: 'approval.risk.low' }; */\n`
  );
  const blockCommentRead = readFunctionScopedMap(blockCommentDecoy, 'riskLabel', 'keys');
  check(
    'self-test: a /* */ comment that mentions the map is not read as the declaration',
    blockCommentRead.error === undefined && blockCommentRead.keys.join(',') === 'safe,low,high',
    blockCommentRead.error ?? `keys=${blockCommentRead.keys.join(', ')}`
  );

  // (xxxviii) A PREFIX-NAMED SIBLING. `indexOf('const keys')` also matched
  // `const keysLegacy = { … }`, so a legacy copy declared first stood in for the real
  // map. The word boundary is what closes this: the sibling must not be read, and the
  // real map must still be found behind it.
  const legacySibling = readFunctionScopedMap(
    webWithPrefix(
      `  const keysLegacy = {\n    safe: 'approval.risk.safe',\n    low: 'approval.risk.low',\n    high: 'approval.risk.high'\n  };\n`
    ),
    'riskLabel',
    'keys'
  );
  check(
    'self-test: a `keysLegacy` sibling is not read as `const keys`',
    legacySibling.error === undefined && legacySibling.keys.join(',') === 'safe,low,high',
    legacySibling.error ?? `keys=${legacySibling.keys.join(', ')}`
  );

  // (xxxix) NO-VACUITY for (xxxviii): the sibling must not be silently accepted as
  // the real map either. With the real map DELETED and only `keysLegacy` left, the
  // read must FAIL rather than return the sibling's keys.
  const legacyOnly = readFunctionScopedMap(
    `function riskLabel(risk) {\n  const keysLegacy = {\n    safe: 'approval.risk.safe',\n    low: 'approval.risk.low'\n  };\n  return tr(keysLegacy[risk] ?? 'approval.risk.unknown');\n}\n`,
    'riskLabel',
    'keys'
  );
  check(
    'self-test: a `keysLegacy`-only body is an error, not the sibling read as the map',
    Boolean(legacyOnly.error) && legacyOnly.error.includes('not found inside function riskLabel()'),
    legacyOnly.error ?? `keys=${legacyOnly.keys?.join(', ')}`
  );

  // (xl) THE DELETED MAP BEHIND A STRING DECOY — the headline web escape. The real
  // `const keys` is gone; only a string literal mentions it. The guard must FAIL
  // rather than report "declares 5 keys" / "5/5 mapped" for a function that would
  // throw at runtime.
  const decoyOnly = inspectWordMapEntry(
    { id: 'RiskLevel@web', union: 'RiskLevel', map: 'keys', function: 'riskLabel', shell: 'web', mapLabel: 'keys (in riskLabel())' },
    routingUnion,
    `function riskLabel(risk) {\n  const hint = "const keys = { safe: 'approval.risk.safe', low: 'approval.risk.low', high: 'approval.risk.high' };";\n  return tr(keys[risk] ?? 'approval.risk.unknown');\n}\n`
  );
  check(
    'self-test: a map deleted behind a string decoy is an error, not a 5/5 read',
    Boolean(decoyOnly.mapError) && decoyOnly.mapKeys.length === 0 && decoyOnly.mapError.includes('not found inside function riskLabel()'),
    decoyOnly.mapError ?? `mapKeys=${decoyOnly.mapKeys.length} (a green read here is the escape this guard exists to stop)`
  );

  // (xli) A MISLABELED real map BEHIND a decoy must be the map that is measured —
  // the decoy must not mask the mislabel. `high` is repointed at `low`'s word, which
  // the shared-target axis catches; if the decoy were read instead, the arm would
  // report the decoy's correct routing and go green.
  const mislabeledBehindDecoy = inspectWordMapEntry(
    { id: 'RiskLevel@web', union: 'RiskLevel', map: 'keys', function: 'riskLabel', shell: 'web', mapLabel: 'keys (in riskLabel())' },
    routingUnion,
    `function riskLabel(risk) {\n  const hint = "const keys = { safe: 'approval.risk.safe', low: 'approval.risk.low', high: 'approval.risk.high' };";\n  const keys = {\n    safe: 'approval.risk.safe',\n    low: 'approval.risk.low',\n    high: 'approval.risk.low'\n  };\n  return tr(keys[risk] ?? 'approval.risk.unknown');\n}\n`
  );
  const mislabeledBehindDecoyFindings = wordMapRoutingFindings({
    inspection: mislabeledBehindDecoy,
    webInspection: null,
    dictionary: 'webDict',
    webDictionary: 'webDict',
    tables: routingTables,
    sharedConcepts: routingConcepts
  });
  check(
    'self-test: a mislabeled map behind a string decoy is still measured',
    mislabeledBehindDecoy.mapError === null
      && mislabeledBehindDecoyFindings.sharedTargets.length === 1
      && mislabeledBehindDecoyFindings.sharedTargets[0][1].join(',') === 'low,high',
    mislabeledBehindDecoy.mapError ?? (mislabeledBehindDecoyFindings.sharedTargets.map(([value, keys]) => `${keys.join(' + ')} -> ${value}`).join(', ') || 'not reported')
  );

  // (xlii) The SAME decoy shapes for the CLI's FILE-SCOPE reader, which had the
  // identical `indexOf` defect. `readWordMap` must read the real declaration, and
  // must FAIL when only a decoy remains.
  const cliStringDecoy = `export function f() {\n  const RISK_HELP = "const riskWordKeys: Record<string, string> = { safe: 'cli.approval.riskSafe', low: 'cli.approval.riskLow' };";\n  const riskWordKeys: Record<string, string> = {\n    safe: 'cli.approval.riskSafe',\n    low: 'cli.approval.riskLow'\n  };\n  return riskWordKeys[x];\n}\n`;
  const cliStringDecoyRead = readWordMap(cliStringDecoy, 'riskWordKeys');
  check(
    'self-test: the cli reader is not fooled by a string decoy either',
    cliStringDecoyRead.error === undefined && cliStringDecoyRead.keys.join(',') === 'safe,low',
    cliStringDecoyRead.error ?? `keys=${cliStringDecoyRead.keys.join(', ')}`
  );
  const cliDecoyOnly = readWordMap(
    `export function f() {\n  const RISK_HELP = "const riskWordKeys: Record<string, string> = { safe: 'cli.approval.riskSafe', low: 'cli.approval.riskLow' };";\n  return riskWordKeys[x];\n}\n`,
    'riskWordKeys'
  );
  check(
    'self-test: the cli reader fails when only a string decoy remains',
    Boolean(cliDecoyOnly.error) && cliDecoyOnly.error.includes('declaration not found'),
    cliDecoyOnly.error ?? `keys=${cliDecoyOnly.keys?.join(', ')}`
  );
  const cliLegacySiblingRead = readWordMap(
    `const riskWordKeysLegacy: Record<string, string> = {\n  safe: 'cli.approval.riskSafe'\n};\nconst riskWordKeys: Record<string, string> = {\n  safe: 'cli.approval.riskSafe',\n  low: 'cli.approval.riskLow'\n};\n`,
    'riskWordKeys'
  );
  check(
    'self-test: the cli reader is not fooled by a `…Legacy` prefix-named sibling',
    cliLegacySiblingRead.error === undefined && cliLegacySiblingRead.keys.join(',') === 'safe,low',
    cliLegacySiblingRead.error ?? `keys=${cliLegacySiblingRead.keys.join(', ')}`
  );

  // (xliii) TWO REAL DECLARATIONS is an ERROR, not a silent pick — the policy the
  // readers document. Both shapes the adversarial proof used land here: a
  // prefix-named sibling that IS a real declaration of the same name is impossible
  // (the name differs), but an early-return branch declaring a second `const keys`,
  // and a file that declares the same map twice, both produce this state. Refusing
  // is the only choice that cannot be fooled: the text cannot say which one the
  // render site reads, and picking the first is exactly what let a stale copy stand
  // in for the real map.
  const twoDeclarations = readFunctionScopedMap(
    `function riskLabel(risk) {\n  if (!risk) {\n    const keys = {\n      safe: 'approval.risk.safe'\n    };\n    return tr(keys.safe);\n  }\n  const keys = {\n    safe: 'approval.risk.safe',\n    low: 'approval.risk.low',\n    high: 'approval.risk.low'\n  };\n  return tr(keys[risk] ?? 'approval.risk.unknown');\n}\n`,
    'riskLabel',
    'keys'
  );
  check(
    'self-test: two real `const keys` declarations are refused, not silently resolved',
    Boolean(twoDeclarations.error)
      && twoDeclarations.error.includes('2 real `const keys` declarations')
      && twoDeclarations.error.includes('lines 3, 8'),
    twoDeclarations.error ?? `keys=${twoDeclarations.keys?.join(', ')}`
  );

  // (xliv) The SCOPED FALLBACK. `lastIndexOf('??')` took whatever `??` came last, so
  // an unrelated `?? 'key'` further down the function replaced the render site's real
  // fallback: the guard asserted a defined decoy while the site's actual fallback was
  // undefined and an unrecognised value printed the raw key string. The read must now
  // follow the map ACCESS.
  const trailingFallbackDecoy = inspectWordMapEntry(
    { id: 'RiskLevel@web', union: 'RiskLevel', map: 'keys', function: 'riskLabel', shell: 'web', mapLabel: 'keys (in riskLabel())' },
    routingUnion,
    `function riskLabel(risk) {\n  const keys = {\n    safe: 'approval.risk.safe',\n    low: 'approval.risk.low',\n    high: 'approval.risk.high'\n  };\n  return tr(keys[risk] ?? 'approval.risk.NOPE') + (getLanguage?.() ?? 'status.idle');\n}\n`
  );
  check(
    'self-test: an unrelated trailing ?? does not replace the render site\'s fallback',
    trailingFallbackDecoy.fallbackKey === 'approval.risk.NOPE',
    `fallbackKey=${JSON.stringify(trailingFallbackDecoy.fallbackKey)} (the trailing decoy would have read "status.idle")`
  );

  // (xlv) Negative control for (xliv): when the site's OWN fallback is the only one,
  // it is still read — the scoping must not break the healthy shape.
  const scopedHealthy = inspectWordMapEntry(
    { id: 'RiskLevel@web', union: 'RiskLevel', map: 'keys', function: 'riskLabel', shell: 'web', mapLabel: 'keys (in riskLabel())' },
    routingUnion,
    `function riskLabel(risk) {\n  const keys = {\n    safe: 'approval.risk.safe',\n    low: 'approval.risk.low',\n    high: 'approval.risk.high'\n  };\n  return tr(keys[risk] ?? 'approval.risk.unknown');\n}\n`
  );
  check(
    'self-test: the render site\'s own ?? fallback is still read when it is the only one',
    scopedHealthy.fallbackKey === 'approval.risk.unknown',
    `fallbackKey=${JSON.stringify(scopedHealthy.fallbackKey)}`
  );

  // (xlvi) The CLI fallback is scoped the same way: a trailing `??` after the
  // indexed use must not replace the real fallback.
  const cliTrailingDecoy = inspectWordMapEntry(
    { id: 'RiskLevel', union: 'RiskLevel', map: 'riskWordKeys', shell: 'cli', mapLabel: 'riskWordKeys' },
    routingUnion,
    `function f() {\n  const riskWordKeys: Record<string, string> = {\n    safe: 'cli.approval.riskSafe'\n  };\n  const risk = tr(riskWordKeys[x] ?? 'cli.approval.riskNOPE');\n  const lang = getLanguage?.() ?? 'cli.status.idle';\n  return risk;\n}\n`
  );
  check(
    'self-test: an unrelated trailing ?? does not replace the cli fallback',
    cliTrailingDecoy.fallbackKey === 'cli.approval.riskNOPE',
    `fallbackKey=${JSON.stringify(cliTrailingDecoy.fallbackKey)} (the trailing decoy would have read "cli.status.idle")`
  );

  // (xlvii) TWO ACCESSES THAT DISAGREE is an error, for the same reason two
  // declarations is: an earlier decoy access would otherwise win, and the text cannot
  // say which access the render site uses. Agreement (the healthy tree has exactly
  // one access per site) is the only resolvable case.
  const disagreeingAccesses = inspectWordMapEntry(
    { id: 'RiskLevel@web', union: 'RiskLevel', map: 'keys', function: 'riskLabel', shell: 'web', mapLabel: 'keys (in riskLabel())' },
    routingUnion,
    `function riskLabel(risk) {\n  const keys = {\n    safe: 'approval.risk.safe',\n    low: 'approval.risk.low',\n    high: 'approval.risk.high'\n  };\n  const probe = keys['safe'] ?? 'approval.risk.safe';\n  return tr(keys[risk] ?? 'approval.risk.NOPE') + probe;\n}\n`
  );
  check(
    'self-test: two map accesses naming different fallbacks are refused',
    Boolean(disagreeingAccesses.mapError) && disagreeingAccesses.mapError.includes('name different fallbacks'),
    disagreeingAccesses.mapError ?? `fallbackKey=${JSON.stringify(disagreeingAccesses.fallbackKey)}`
  );

  // (xlviii) A fallback-less site still reads as `null` through the SCOPED reader —
  // the state the runner treats as "this site has no fallback", and never an error.
  const scopedNoFallback = inspectWordMapEntry(
    { id: 'RiskLevel@web', union: 'RiskLevel', map: 'keys', function: 'riskLabel', shell: 'web', mapLabel: 'keys (in riskLabel())' },
    routingUnion,
    `function riskLabel(risk) {\n  const keys = {\n    safe: 'approval.risk.safe'\n  };\n  return tr(keys[risk]);\n}\n`
  );
  check(
    'self-test: a fallback-less site reads as null through the scoped reader',
    scopedNoFallback.fallbackKey === null && scopedNoFallback.error === undefined,
    `fallbackKey=${JSON.stringify(scopedNoFallback.fallbackKey)}`
  );

  // (xlix) A REGEX LITERAL containing a brace must not unbalance the body bound.
  // `findBlockEnd` counted `/}/` as a real `}`, so the body ended early and the map
  // behind it was reported missing — a false FAIL, and the one direction that cannot
  // hide a gap but that made the guard lie about a legitimate file.
  const regexBraceBody = readFunctionScopedMap(
    `function riskLabel(risk) {\n  const marker = /}/;\n  const keys = {\n    safe: 'approval.risk.safe',\n    low: 'approval.risk.low'\n  };\n  return tr(keys[risk] ?? 'approval.risk.unknown') + marker.source;\n}\n`,
    'riskLabel',
    'keys'
  );
  check(
    'self-test: a regex literal containing a brace does not end the function body early',
    regexBraceBody.error === undefined && regexBraceBody.keys.join(',') === 'safe,low',
    regexBraceBody.error ?? `keys=${regexBraceBody.keys.join(', ')}`
  );

  // (l) THE APOSTROPHE IN HTML TEXT. The SPA is HTML with inline modules, so an
  // apostrophe inside an HTML comment (`the composer popover's keys`) is not a string
  // opener. A mask that treated it as one swallowed ~9,900 characters and masked two
  // real `const` declarations and a `function tr(` — over-masking, which HIDES code
  // and is the one direction a mask must never take. This drives the real reader over
  // a source carrying that shape.
  const htmlApostrophe = readFunctionScopedMap(
    `<!-- it reuses the composer popover's keys so the two surfaces -->\n<div id="x" class="y"></div>\nfunction riskLabel(risk) {\n  const keys = {\n    safe: 'approval.risk.safe',\n    low: 'approval.risk.low'\n  };\n  return tr(keys[risk] ?? 'approval.risk.unknown');\n}\n`,
    'riskLabel',
    'keys'
  );
  check(
    'self-test: an apostrophe in HTML text does not mask the code after it',
    htmlApostrophe.error === undefined
      && htmlApostrophe.keys.join(',') === 'safe,low'
      && htmlApostrophe.fallbackKey === 'approval.risk.unknown',
    htmlApostrophe.error ?? `keys=${htmlApostrophe.keys.join(', ')}, fallbackKey=${JSON.stringify(htmlApostrophe.fallbackKey)}`
  );

  // (li) The mask must never mask REAL code. Asserted over the fixtures the cases
  // above use rather than by inspection: every `const `, `function ` and `tr(` token
  // in a healthy source must still be marked as code.
  const maskProbe = webWithPrefix('');
  const maskProbeMask = codeMask(maskProbe);
  const maskedTokens = [
    ...[...maskProbe.matchAll(/(?<![\w$.])const\s/g)].map((match) => match.index),
    ...[...maskProbe.matchAll(/(?<![\w$.])function\s/g)].map((match) => match.index),
    ...[...maskProbe.matchAll(/(?<![\w$.])tr\(/g)].map((match) => match.index)
  ].filter((at) => !maskProbeMask[at]);
  check(
    'self-test: the code mask never masks a real const/function/tr token',
    maskedTokens.length === 0,
    maskedTokens.length ? `${maskedTokens.length} real token(s) masked at ${maskedTokens.join(', ')}` : 'every real token left as code'
  );

  // (lii) The mask must leave the CODE projection BRACE-BALANCED. A `${` inside a
  // template is not code — the `{` is part of the template — so masking the `{`
  // without its matching `}` unbalances the projection, and `findBlockEnd` bounds a
  // body by brace depth: one stray brace closes the body early and the region read
  // after it is wrong. This is asserted on the real SPA, where `${…}` appears inside
  // function bodies, and on a fixture carrying a nested object inside the expression
  // so the depth tracking is exercised rather than merely the flat case.
  const templateSource = 'function f() {\n  const msg = `a ${x ? { n: 1 } : { n: 2 }} b`;\n  return msg;\n}\n';
  const templateMask = codeMask(templateSource);
  const balance = (source, mask) => {
    let depth = 0;
    for (let index = 0; index < source.length; index += 1) {
      if (!mask[index]) continue;
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') depth -= 1;
    }
    return depth;
  };
  const realSpa = readSourceFile('packages/ui/public/index.html');
  const realSpaBalance = realSpa.error ? NaN : balance(realSpa.source, codeMask(realSpa.source));
  check(
    'self-test: the code mask leaves braces balanced (a ${ } must not unbalance a body)',
    balance(templateSource, templateMask) === 0 && realSpaBalance === 0,
    `fixture balance=${balance(templateSource, templateMask)}, ${realSpa.error ? 'SPA unreadable' : `real SPA balance=${realSpaBalance}`}`
  );

  // --- the implementation-detail value rules -------------------------------
  //
  // One positive and one negative case per shape, driven through the SAME
  // `valueDetailHits` the real scan calls, so a rule that stops firing fails
  // here as well as in the run above. The negative halves are the near-misses
  // that would turn the rule set into a false-positive generator: bare numbers,
  // a CSS hex colour, camelCase identifiers, dotted names, and the `a/b` pair
  // inside a word.
  const commands = productSlashCommandSet;

  // The fixture travels through the real value scan: the defect value below is
  // sliced from a synthetic dictionary and reported by `valueDetailHits`, which
  // proves the scan reaches a table rather than only that the regexes work.
  const defectValue = "'Stored locally in /Users/kayphoon/.myagent/ui-settings.json (0600), using OPENAI_API_KEY to call /models.'";
  const defectTables = fixtureTables('defectDict', [['hint', defectValue]], [['hint', defectValue]]);
  const defectHits = defectTables.defectDict.zh.entries.flatMap((record) => valueDetailHits(record.value, commands));
  check(
    'self-test: all four implementation-detail shapes are reported in one value',
    ['filesystem path', 'file mode', 'environment variable', 'bare endpoint'].every((id) => defectHits.some((hit) => hit.startsWith(id))),
    defectHits.join(' | ') || 'no hit'
  );

  check(
    'self-test: a filesystem path is reported and an endpoint-shaped word is not',
    valueDetailHits('Stored in /Users/kayphoon/.myagent/ui-settings.json', commands).some((hit) => hit.startsWith('filesystem path')) &&
      valueDetailHits('本地保存在 .myagent/ui-settings.json', commands).some((hit) => hit.startsWith('filesystem path')) &&
      valueDetailHits('Saved to C:\\Users\\kay\\.myagent', commands).some((hit) => hit.startsWith('filesystem path')) &&
      !valueDetailHits('See README.md or v1.2.3 for details', commands).length,
    JSON.stringify([...valueDetailHits('Stored in /Users/kayphoon/.myagent/ui-settings.json', commands), ...valueDetailHits('本地保存在 .myagent/ui-settings.json', commands), ...valueDetailHits('See README.md or v1.2.3 for details', commands)])
  );

  check(
    'self-test: a permission mode is reported and bare numbers are not',
    valueDetailHits('权限 0600，仅本人可读', commands).some((hit) => hit.startsWith('file mode')) &&
      valueDetailHits('Set the limit to 4096 and retry 200 times', commands).length === 0 &&
      valueDetailHits('--siu-accent: #0071e3; --siu-text-inverse: #06070b;', commands).length === 0,
    JSON.stringify([...valueDetailHits('权限 0600，仅本人可读', commands), ...valueDetailHits('Set the limit to 4096 and retry 200 times', commands)])
  );

  check(
    'self-test: an env-var name is reported and camelCase identifiers are not',
    valueDetailHits('using OPENAI_API_KEY to call the provider', commands).some((hit) => hit.startsWith('environment variable')) &&
      valueDetailHits('apiKey, baseURL, Authorization and activeProviderId', commands).length === 0,
    JSON.stringify([...valueDetailHits('using OPENAI_API_KEY to call the provider', commands), ...valueDetailHits('apiKey, baseURL, Authorization and activeProviderId', commands)])
  );

  check(
    'self-test: a bare endpoint is reported and documented slash commands are not',
    valueDetailHits('calls the /models route', commands).some((hit) => hit.startsWith('bare endpoint')) &&
      valueDetailHits('POST (/api/chat', commands).some((hit) => hit.startsWith('bare endpoint')) &&
      valueDetailHits('清除当前上下文 (/clear)', commands).length === 0 &&
      valueDetailHits('either/or and/or both', commands).length === 0,
    JSON.stringify([...valueDetailHits('calls the /models route', commands), ...valueDetailHits('清除当前上下文 (/clear)', commands), ...valueDetailHits('either/or and/or both', commands)])
  );

  // The rules must be clean on the REAL values through the real helper, which is
  // the statement the run above makes; asserting it here means a future edit
  // that makes the rules noisy fails inside the self-test too.
  const realValueHits = sources.flatMap((entry) => LANGUAGES.flatMap((language) => tables[entry.id][language].entries.flatMap((record) => valueDetailHits(record.value, commands).map((hit) => `${entry.id}/${language} ${record.key}: ${hit}`))));
  check(
    'self-test: the value implementation-detail rules are clean on the real dictionaries',
    realValueHits.length === 0,
    realValueHits.slice(0, 3).join(' | ') || `clean across ${valueDetailScanned} values`
  );
}

console.log(failures === 0 ? '\nCross-dictionary parity check passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
