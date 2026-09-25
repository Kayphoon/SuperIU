/**
 * UI localization guard for the web shell (packages/ui/public/index.html).
 *
 * The inline SPA module must render every user-visible string through the
 * i18n table. Two classes of defect have shipped here:
 *
 *   1. a hardcoded CJK literal, and
 *   2. a hardcoded ENGLISH literal concatenated into the DOM
 *      (`apiKeyMasked + ' (unchanged)'`), which a CJK-only scan cannot see and
 *      which renders untranslated in the Chinese UI.
 *
 * Scope is deliberately narrow. A whole-file prose heuristic reports the
 * pre-existing About-pane env dump ('OPENAI_BASE_URL: ', '(unset)') and the
 * console diagnostics, none of which are user-visible copy and none of which
 * this change is allowed to touch. So the guard covers exactly the settings
 * pane and the provider master-detail: the code this repo actively edits.
 *
 * Run: node scripts/check-ui-i18n.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(REPO, 'packages/ui/public/index.html');
const I18N_PATH = path.join(REPO, 'packages/ui/public/i18n.js');

/** Functions that make up the settings pane and the provider master-detail. */
const SETTINGS_FUNCTIONS = [
  'providerDraftFrom',
  'providerDescription',
  'providerDisplayName',
  'providerFingerprint',
  'findDraftProvider',
  'setActiveProvider',
  'renderProviderList',
  'renderProviderDetail',
  'renderProviderKeyToggle',
  'renderProviderModels',
  'renderSettingsDirty',
  'renderSettingsDynamic'
];

/** Extract a function body by walking braces, not by guessing at delimiters. */
function extractFunction(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) return null;
  const bodyStart = source.indexOf('{', source.indexOf(')', match.index));
  if (bodyStart === -1) return null;
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, i + 1);
    }
  }
  return null;
}

/** Strip comments so prose inside them is not mistaken for a literal. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '');
}

/** String literals, matched per line so a stray quote cannot swallow a block. */
function stringLiterals(source) {
  const out = [];
  source.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g)) {
      out.push({ value: match[1] ?? match[2], line: index + 1 });
    }
  });
  return out;
}

/**
 * A literal that is a sentence rather than a class token, id, or selector.
 * Whitespace is tested on the RAW value: a suffix such as ' (unchanged)' has a
 * space only at its edge, so trimming first would reduce it to a single word
 * and let the exact regression this guard exists for slip through.
 */
function looksLikeCopy(value) {
  if (!/\s/.test(value)) return false;
  const text = value.trim();
  if (/[<>="[\]{}`]/.test(text)) return false;
  const tokens = text.split(/\s+/);
  const isUtilityToken = (token) => /^(siu|mt|mb|ml|mr|px|py|pt|pb|gap|flex|grid|font|text|opacity|absolute|relative|min|max|w|h|leading|tracking)(-|$)/.test(token);
  if (tokens.every((token) => isUtilityToken(token))) return false;
  return /[A-Za-z]{3,}/.test(text);
}

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  → ${detail}` : ''}`);
}

// --- extract the region under guard -----------------------------------------

const html = fs.readFileSync(HTML_PATH, 'utf-8');
const moduleMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!moduleMatch) {
  console.error('FAIL  index.html has no inline type="module" script');
  process.exit(1);
}
const moduleBody = moduleMatch[1];

const extracted = new Map(SETTINGS_FUNCTIONS.map((name) => [name, extractFunction(moduleBody, name)]));
const missing = SETTINGS_FUNCTIONS.filter((name) => !extracted.get(name));
check('every guarded function is present', missing.length === 0, missing.join(', '));

// Guard against a vacuous pass: an extractor that finds nothing would make
// every literal check below trivially green.
const region = [...extracted.values()].filter(Boolean).join('\n');
check('extraction captured a real region', region.split('\n').length > 150, `${region.split('\n').length} lines`);

// --- the checks -------------------------------------------------------------

const code = stripComments(region);
const literals = stringLiterals(code);

const cjk = [...new Set(literals.filter((l) => /[\u4e00-\u9fff]/.test(l.value)).map((l) => l.value))];
check('no hardcoded Chinese literal in the settings/provider region', cjk.length === 0, cjk.join(' | ') || 'clean');

const unlocalized = [
  ...new Set(
    literals
      .filter((l) => looksLikeCopy(l.value))
      .map((l) => `${JSON.stringify(l.value)} (region line ${l.line})`)
  )
];
check('no hardcoded English copy in the settings/provider region', unlocalized.length === 0, unlocalized.join(' | ') || 'clean');

// The specific regression: the key placeholder must be interpolated, never
// concatenated, or the Chinese UI shows "sk-••••1234 (unchanged)".
check(
  'key placeholder interpolates its suffix via tr()',
  /tr\(\s*'settings\.providers\.apiKey\.unchanged'\s*,\s*\{\s*masked:/.test(code),
  'expected tr(..., { masked: ... })'
);
check('no literal "unchanged" suffix remains', !/' \(unchanged\)'/.test(code) && !/" \(unchanged\)"/.test(code));

const i18nSource = fs.readFileSync(I18N_PATH, 'utf-8');
// Slice each table by its literal prefix. Scanning the whole file for keys
// would make zhKeys the UNION of both tables, so a key present in en but
// missing from zh would still satisfy every check below.
const zhStart = i18nSource.indexOf('\n  zh: {');
const enStart = i18nSource.indexOf('\n  en: {');
if (zhStart === -1 || enStart === -1 || zhStart >= enStart) {
  console.error('FAIL  could not locate the zh: { and en: { blocks in i18n.js');
  process.exit(1);
}
const zhBlock = i18nSource.slice(zhStart, enStart);
const enBlock = i18nSource.slice(enStart);
const zhKeys = new Set([...zhBlock.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
const enKeys = new Set([...enBlock.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
check('zh table block is non-empty', zhKeys.size > 0, `${zhKeys.size} keys`);
check('en table block is non-empty', enKeys.size > 0, `${enKeys.size} keys`);
check('zh and en tables cover identical keys', zhKeys.size === enKeys.size && [...zhKeys].every((k) => enKeys.has(k)), `zh=${zhKeys.size} en=${enKeys.size}`);
check('settings.providers.apiKey.unchanged exists', zhKeys.has('settings.providers.apiKey.unchanged') && enKeys.has('settings.providers.apiKey.unchanged'));
// The notify.* titles are deliberately bilingual: they surface as macOS
// notification banners, which the OS renders outside the page's language
// context, so they carry both scripts on purpose. Every other key must be
// Chinese-free in the en table.
const BILINGUAL_KEYS = new Set([
  'notify.taskComplete',
  'notify.approvalRequired',
  'notify.error',
  'notify.alertsEnabled'
]);
const enEntries = [...enBlock.matchAll(/^\s*'([^']+)':\s*'([^']*)'/gm)].map((m) => ({ key: m[1], value: m[2] }));
const enCjk = enEntries.filter((e) => /[\u4e00-\u9fff]/.test(e.value) && !BILINGUAL_KEYS.has(e.key));
check('no CJK leaked into the en table', enCjk.length === 0, enCjk.map((e) => e.key).join(', ') || 'clean');
check('bilingual notify titles are still bilingual', enEntries.filter((e) => BILINGUAL_KEYS.has(e.key)).every((e) => /[\u4e00-\u9fff]/.test(e.value)));

// Every tr() key referenced in the region must exist in both tables.
const referenced = [...new Set([...code.matchAll(/tr\(\s*'([^']+)'/g)].map((m) => m[1]))].filter((k) => !k.endsWith('.'));
const unresolved = referenced.filter((k) => !zhKeys.has(k) || !enKeys.has(k));
check('every tr() key in the region is defined in both tables', unresolved.length === 0, unresolved.join(', ') || `${referenced.length} keys checked`);

// --- self-test: the checks must be able to fail ------------------------------

{
  const probe = `function renderProviderDetail() { key.placeholder = provider.apiKeyMasked + ' (unchanged)'; }`;
  const probeCode = stripComments(probe);
  const caught = stringLiterals(probeCode).some((l) => looksLikeCopy(l.value));
  check('self-test: the regression is detectable', caught && /' \(unchanged\)'/.test(probeCode));
}

console.log(failures === 0 ? '\nUI localization guard passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
