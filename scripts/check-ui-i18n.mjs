/**
 * UI localization guard for the web shell.
 *
 * INPUT SET — three files, all served to the browser:
 *
 *   1. `packages/ui/public/index.html` — the inline `<script type="module">`
 *      (scanned by REGION, see below) plus its static markup;
 *   2. `packages/ui/public/i18n.js` — the dictionary, both tables;
 *   3. `packages/ui/public/notifications.js` — a separate `type="module"`
 *      script (`index.html` loads it at its own `<script src>`) that the guard
 *      reaches with a REDUCED check set; see the scope decision below.
 *
 * The inline SPA module must render every user-visible string through the
 * i18n table. Two classes of defect have shipped here:
 *
 *   1. a hardcoded CJK literal, and
 *   2. a hardcoded ENGLISH literal concatenated into the DOM
 *      (`apiKeyMasked + ' (unchanged)'`), which a CJK-only scan cannot see and
 *      which renders untranslated in the Chinese UI.
 *
 * Scope covers the regions that render user-visible copy: the settings
 * pane / provider master-detail, the composer toolbar (model + effort
 * popovers, context meter, favorite models), the session/status renderers
 * (`runSlash`'s /status and /sessions cards, `renderSessions`, `renderStatus`),
 * the transcript/approval renderers (the message stream, tool and thinking
 * cards, the approval card, emotion meters, the toast host), and the remaining
 * chrome (command palette, input history, completion menu, notify button,
 * settings filler, model and theme selects).
 *
 * The fourth and fifth regions were absent for the same reason the third once
 * was: the renderers were never added to the guarded function list. A census
 * measured the guard against the tree and found it scanned only 32 of the 124
 * functions the module declares — the figure that held while three regions were
 * guarded; it is 61 of those same 124 across the five regions below, and moves
 * whenever a region is added. Planting `list.textContent = 'No history yet'`
 * into the unguarded `renderHistoryList()` passed while the identical string in
 * a guarded renderer failed, which isolates scope — not the detector — as the
 * cause. The durable lesson is narrower than a quotation: a scope exemption is
 * derived from the code it covers, so when that code changes the exemption has
 * to be re-derived, not inherited.
 *
 * The detector was rebuilt at the same time. It previously required whitespace
 * AND a 3+ letter word, which made single-token copy structurally invisible:
 * planting a hardcoded `'(root)'` where `tr('status.card.root')` belongs left
 * the guard green. It is now defined negatively — a literal is copy unless it
 * is explainable as a key name, class soup, DOM id, attribute, tag, enum token,
 * path, unit, glyph run or number — and it is calibrated against the module's
 * real corpus of several hundred literals, where it accepts exactly the two
 * `console.warn` diagnostics. Both corpora are pinned in the self-test, so
 * widening or narrowing the detector fails loudly instead of silently.
 *
 * Static markup is scanned too. Every check above reads only the inline module,
 * so a string hardcoded in the HTML was invisible to all of them: `#notify-label`
 * held raw Chinese `通知` with no `data-i18n`, so an English-locale user saw
 * Chinese from first paint until boot ran. It is rewritten by a `tr()` call at
 * runtime, so the leak was a first-paint window rather than a permanent one; the
 * `data-i18n` annotation has since been added, which closes it. The scan reports
 * every unannotated text element and fails on any that is not on the explicit
 * allowlist.
 *
 * KEY RESOLUTION is checked twice, and the two are not redundant. The region
 * checks resolve the keys of the 61 functions in REGIONS; the whole-file check
 * resolves every `tr()` key literal in `index.html` and `notifications.js` plus
 * every `data-i18n*` attribute value, wherever it lives. The region list is a
 * scope decision that has to be re-derived when the module is refactored, and
 * two blind spots were measured as a consequence: a `tr()` call outside the five
 * regions and a `data-i18n*` value that no check ever resolved. Planting
 * `tr('palette.quitZZZ')` at line 6179 and `data-i18n="settings.themeZZZ"` at
 * line 3481 left the guard green (the static attribute checks assert an
 * annotation EXISTS, never that its value resolves). The whole-file scan cannot
 * fall behind the code it covers, so it is the load-bearing one for coverage and
 * the region checks keep the axes that need a bounded scope. The unguardable
 * literals — dynamic prefixes (`'badge.'` in `tr('badge.' + status)`), literals
 * carrying a template placeholder, and anything not `segment.segment`
 * key-shaped — are excluded, and the excluded set is printed rather than
 * silently dropped.
 *
 * A third class is checked by POSITION rather than by value. The rebuilt
 * predicate classifies a literal by its text alone, so every token it must
 * tolerate as a code token (`'low'`, `'off'`, `'none'`, `'n/a'`) is invisible
 * wherever it lands — which is how `<option value="low">low</option>` and
 * `payload.leafId || 'root'` shipped. The position axis reports a literal only
 * when it sits in a display position AND the value predicate declines it; the
 * partition reports zero findings on the clean tree. Neither axis is usable
 * alone: a display-position census taken at design time counted many class
 * tokens in `el()` calls — a design-time measurement, NOT reproducible from the
 * current file, and therefore deliberately not restated as a figure here — and
 * widening the value predicate instead needs an allowlist that grows with the
 * enum vocabulary. What the position axis cannot see: a display sink it does
 * not know, and copy assembled outside a `tr()` call in a position the sink
 * list misses.
 *
 * The value check and the position check are a PARTITION, not two overlapping
 * detectors. `unlocalized` is the value axis: every literal `looksLikeCopy()`
 * ACCEPTS, reported in ANY position, because a value predicate cannot know
 * where a literal will land. `displayPosition` is the position axis: every
 * literal the predicate DECLINES that also sits in a display window. A literal
 * is therefore reported by at least one axis unless the predicate declines it
 * and it stays out of every display sink — data or code, not copy. Nothing is
 * counted twice: each axis skips exactly what the other owns.
 *
 * That partition is what makes the vocabulary safe to extend, and it is the
 * one property whose loss would be silent. Adding a token to `ENUM_TOKENS`
 * (the usual set) silences the value axis and hands the token to the position
 * axis, which still reports it in EVERY display sink — all four
 * `DISPLAY_PROPERTIES`, all four `DISPLAY_ATTRIBUTES`, all three
 * `DISPLAY_CALLS`, and `el()`'s text argument — while staying silent for
 * comparisons, `dataset` writes and `filter()` predicates. So the vocabulary
 * is the extension point, NOT the predicate: naming a token widens what the
 * guard treats as code and creates no blind spot, because the position axis
 * takes over. The other sets a bare token can belong to are
 * `ARIA_ROLE_NAMES`, `UNIT_TOKENS`, `KEY_NAMES`, `DOM_TOKEN_NAMES`,
 * `HTML_TAGS`, `ATTRIBUTE_NAMES`, `EVENT_NAMES` and `JS_TYPE_NAMES`.
 *
 * The self-test pins all of it: the vocabulary-miss default (unknown bare
 * token reported by the value axis even in a pure comparison), both directions
 * of the iff that splits the axes, and the invariant that the two axes
 * together account for every literal in a body. The value axis also names the
 * set that resolves a bare-token finding, so the mechanical fix is one line.
 *
 * Run: node scripts/check-ui-i18n.mjs
 *
 * --- SCOPE DECISION: notifications.js is checked by a REDUCED axis set ------
 *
 * `notifications.js` is guarded by the CJK axis, the position axis and `tr()`
 * key parity. The whole-file VALUE axis is deliberately NOT applied to it, and
 * that omission is a measured decision rather than an oversight.
 *
 * The value axis is unusable there because the vocabulary sets were
 * census-calibrated on `index.html` alone, and this file carries a Web Audio /
 * CSS / Web-Animations domain that `index.html` never has (measured: AudioContext
 * 0→7, createOscillator 0→1, createBiquadFilter 0→1, latencyHint 0→1,
 * `.animate(` 0→3). Run over the clean file it reports 37 hits covering 23
 * distinct literals — `'SF Pro Text'`, `'Helvetica Neue'`, `'Segoe UI'`,
 * `'cubic-bezier(0.22, 1, 0.36, 1)'`, `'translateX(112%) scale(.96)'`,
 * `'sine'`, `'lowpass'`, `'triangle'`, `'interactive'`, `'pointerdown'`,
 * `'assertive'`, `'polite'`, `'_blank'`, `'noreferrer'`, `'unsupported'`,
 * `'success'`, `'approval'` and the rest. Applying it would fail clean code, so
 * neither the axis nor an allowlist for this file is used here.
 *
 * KNOWN, DOCUMENTED GAP — the hole is NOT closed. Because the value axis is not
 * applied, a literal that `looksLikeCopy()` ACCEPTS is invisible in this file in
 * EVERY position, display sinks included. That is structural, not incidental:
 * the position axis reports only literals the value predicate DECLINES (the
 * partition), so with the value axis off, an accepted literal has no axis left
 * to report it. Measured: planting `new Notification('Notifications unavailable')`
 * into the real file passes, and so does
 * `p.textContent='Notifications unavailable'` — the display sink makes no
 * difference, because `looksLikeCopy('Notifications unavailable')` is true and
 * the position axis skips exactly what the value axis owns. What IS still caught
 * in this file: a CJK literal, a DECLINED literal in a display sink, and an
 * unresolved `tr()` key — all three verified by planting each into the real file
 * and watching this guard fail. Closing the accepted-literal hole needs either a
 * re-census of the vocabulary against this file's domain or a second,
 * notifications-specific calibration, both of which the scope decision above
 * deliberately rules out of this check set.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(REPO, 'packages/ui/public/index.html');
const I18N_PATH = path.join(REPO, 'packages/ui/public/i18n.js');
const NOTIFICATIONS_PATH = path.join(REPO, 'packages/ui/public/notifications.js');

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

/**
 * Functions that make up the composer toolbar: the model and effort popovers,
 * the context meter, and the favorite-model store they read and write.
 */
const COMPOSER_FUNCTIONS = [
  'groupDigits',
  'readFavoriteModels',
  'writeFavoriteModels',
  'toggleFavoriteModel',
  'effortPillLabel',
  'effortOptionLabel',
  'renderContextMeter',
  'renderComposerControls',
  'hideComposerPopovers',
  'focusPopoverRow',
  'activatePopoverRow',
  'modelBadges',
  'modelRow',
  'renderModelPopover',
  'renderEffortPopover',
  'selectModel',
  'selectEffort'
];

/**
 * Functions that render the session and status surfaces: `runSlash` builds the
 * /status and /sessions cards, `renderSessions` paints the session select and
 * sidebar list, and `renderStatus` fills the More drawer's status panel. These
 * are not composer code, so they get their own region rather than inflating
 * the composer label — a mislabelled failure sends the reader to the wrong
 * file section.
 */
const SESSION_FUNCTIONS = ['runSlash', 'renderSessions', 'renderStatus'];

/**
 * Functions that paint the transcript and the approval card: the message
 * stream (`sendPrompt`), its empty state and bubbles, the tool/thinking/step
 * primitives and their status badges, the approval card and its retirement,
 * the emotion meters, and the toast host.
 *
 * This region was added after a census measured the guard against the tree and
 * found it scanned only 32 of the 124 functions the module declares — the
 * figure that held while three regions were guarded; across the five regions
 * below it is 61 of those same 124. Planting `list.textContent = 'No
 * history yet'` into an unguarded renderer passed while the identical string in
 * a guarded one failed — isolating scope, not the detector, as the cause. The
 * blind spot was systematic: the guard's function list was written when these
 * renderers predated the localization pass, and it was never re-derived as they
 * became copy-bearing. Every function here writes text into the DOM.
 */
const TRANSCRIPT_FUNCTIONS = [
  'sendPrompt',
  'renderMessages',
  'renderEmptyState',
  'userBubble',
  'attachCopy',
  'statusBadge',
  'toolCard',
  'setToolStatus',
  'thinkingBlock',
  'stepGroup',
  'riskChip',
  'reviewerLabel',
  'approvalCard',
  'retireApproval',
  'setStatus',
  'statusLabel',
  'renderEmotion',
  'renderSessionFile',
  'toast'
];

/**
 * Functions that paint the remaining chrome: the command palette, the input
 * history list, the completion menu, the notify button, the settings form's
 * filler and its reasoning hint, the model select, the theme select, and the
 * popover group heading.
 *
 * Kept apart from the transcript region so a failure names the right file
 * section — and so each region carries its own line floor. A single merged
 * region would have a floor satisfied by the transcript alone, which would make
 * the floor vacuous for this half.
 */
const CHROME_FUNCTIONS = [
  'renderPalette',
  'renderHistoryList',
  'renderCompletions',
  'closeCompletions',
  'renderNotifyButton',
  'fillSettingsForm',
  'renderReasoningHint',
  'fillModelSelect',
  'renderThemeSelect',
  'popoverGroupHead'
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

// --- the non-copy vocabulary -------------------------------------------------
//
// The predicate below is defined negatively: a literal is copy UNLESS it is
// explainable as one of the non-copy classes this module legitimately contains.
// The previous revision was defined positively — it required whitespace AND a
// 3+ letter word — so single-token copy was structurally invisible. Planting a
// hardcoded '(root)' where `tr('status.card.root')` belongs left the guard
// green, which is the defect this vocabulary closes.
//
// The lists are not invented; they were harvested from a census of every
// literal in the module and then pruned until the predicate accepted only the
// known-benign diagnostics below. The calibration is itself regression-tested
// in the self-test at the bottom of this file: `COPY_CORPUS` must be caught and
// `NON_COPY_CORPUS` must be ignored, so a future edit that widens or narrows
// the detector fails loudly.

/** Element names passed to `el()` or emitted inside an inline SVG template. */
const HTML_TAGS = new Set([
  'a', 'b', 'br', 'button', 'canvas', 'circle', 'code', 'dd', 'defs', 'details', 'div', 'dl', 'dt', 'em',
  'fieldset', 'footer', 'form', 'g', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'iframe',
  'img', 'input', 'label', 'legend', 'li', 'main', 'nav', 'ol', 'option', 'p', 'path', 'polyline', 'pre',
  'rect', 's', 'section', 'select', 'small', 'source', 'span', 'strong', 'summary', 'svg', 'table',
  'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'tr', 'ul', 'use', 'video'
]);

/** Attribute names, including the SVG presentation attributes used inline. */
const ATTRIBUTE_NAMES = new Set([
  'alt', 'aria', 'checked', 'class', 'cols', 'content', 'cx', 'cy', 'd', 'dir', 'disabled', 'fill', 'for',
  'height', 'hidden', 'href', 'id', 'lang', 'max', 'min', 'name', 'open', 'placeholder', 'r', 'rel', 'role',
  'rows', 'rx', 'ry', 'src', 'stroke', 'style', 'tabindex', 'target', 'title', 'type', 'value', 'viewbox',
  'width', 'x', 'y'
]);

/** DOM event names, which appear as the first argument to addEventListener. */
const EVENT_NAMES = new Set([
  'abort', 'animationend', 'beforeunload', 'blur', 'change', 'click', 'contextmenu', 'copy', 'dblclick',
  'drag', 'dragend', 'dragstart', 'drop', 'error', 'focus', 'focusin', 'focusout', 'input', 'invalid',
  'keydown', 'keypress', 'keyup', 'load', 'mousedown', 'mouseenter', 'mouseleave', 'mousemove', 'mouseup',
  'paste', 'popstate', 'resize', 'scroll', 'select', 'submit', 'touchend', 'touchstart', 'transitionend',
  'toggle', 'wheel'
]);

/** `typeof x === '...'` results, plus the boolean literals. */
const JS_TYPE_NAMES = new Set(['bigint', 'boolean', 'false', 'function', 'null', 'number', 'object', 'string', 'symbol', 'true', 'undefined']);

/** Values of `input.type` / `style.textAlign`-style DOM enums. */
const DOM_TOKEN_NAMES = new Set([
  'auto', 'center', 'checkbox', 'color', 'date', 'datetime-local', 'email', 'file', 'hidden', 'left', 'month',
  'none', 'password', 'radio', 'range', 'reset', 'right', 'search', 'submit', 'tel', 'text', 'time', 'url', 'week'
]);

/**
 * The closed ARIA role set (`role` / `setAttribute('role', ...)` values).
 *
 * This is a fixed list from the spec, so it cannot drift, and it is NOT copy:
 * `setAttribute('role', 'presentation')` inside a guarded region was reported
 * as hardcoded English and the workaround was to hoist the literal to a
 * module-level constant OUTSIDE every guarded region — which silenced the
 * symptom and left the false positive for the next person to hit. Naming the
 * role vocabulary is the fix; a role token is DOM vocabulary in every
 * position, so it belongs here rather than in a display-sink exemption.
 *
 * Only `presentation` is written inline in a guarded region today; the other
 * roles this module uses reach the screen as `role="..."` markup in the static
 * shell (`listbox`, `dialog`, `tablist`, …), which no module literal scan
 * reads. The set is closed, so the whole of it is declared rather than the
 * subset a census happened to find — the point is that the next role written
 * inline is already vocabulary, not a new false positive.
 */
const ARIA_ROLE_NAMES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell',
  'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion',
  'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell',
  'group', 'heading', 'img', 'insertion', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee',
  'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'none',
  'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row',
  'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status',
  'strong', 'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox',
  'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem'
]);

/**
 * Internal enum tokens: SSE event kinds, status ids, risk levels, provider
 * roles, theme and language codes, `dataset` values. These are data, not copy,
 * and they are the single largest class of bare lowercase literal in the file.
 */
const ENUM_TOKENS = new Set([
  'aborted', 'about', 'approval_request', 'approved', 'assistant', 'auto', 'badge', 'baseline', 'chunk',
  'clear', 'complete', 'completed', 'content', 'critical', 'custom', 'danger', 'dark', 'denied', 'details',
  'done', 'en', 'error', 'focus', 'general', 'granted', 'high', 'idle', 'info', 'light', 'low', 'main',
  'medium', 'message', 'more', 'new', 'notify', 'off', 'ok', 'on', 'palette', 'pending', 'prompt',
  'providers', 'quit', 'reasoning', 'rejected', 'review', 'role', 'running', 'sessions', 'settings',
  'stale', 'status', 'step', 'streaming', 'summary', 'system', 'thinking', 'toast', 'tool', 'tool_call',
  'tool_calling', 'tool_result', 'transcript', 'unset', 'user', 'warn', 'zh'
]);

/** Numeric unit suffixes appended to a measurement (`ms`, `px`, `%`). */
const UNIT_TOKENS = new Set(['b', 'ch', 'd', 'em', 'gb', 'h', 'kb', 'm', 'mb', 'ms', 'px', 'rem', 's', 'vh', 'vw']);

/** Keyboard/HTTP tokens: `event.key` names, MIME types, HTTP verbs. */
const KEY_NAMES = new Set([
  'AbortError', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'Backspace', 'CapsLock', 'Content-Type',
  'Control', 'DELETE', 'Delete', 'End', 'Enter', 'Escape', 'GET', 'Home', 'Meta', 'PATCH', 'POST', 'PUT',
  'PageDown', 'PageUp', 'Shift', 'Space', 'Tab', 'application/json', 'multipart/form-data', 'text/plain'
]);

/**
 * Tailwind utility prefixes. A `className` argument is a class token, not
 * rendered copy — including `p-3`, whose rendered text is already translated.
 */
const CSS_UTILITY = /^(?:absolute|aspect|bg|block|border|bottom|col|container|cursor|duration|ease|fill|fixed|flex|font|gap|grid|h|hidden|inline|inset|items|justify|leading|left|list|m|max|mb|min|ml|mr|mt|mx|my|opacity|order|outline|overflow|p|pb|pl|pointer|pr|pt|px|py|relative|resize|right|rounded|row|select|shadow|shrink|siu|space|static|sticky|stroke|table|text|top|tracking|transition|translate|truncate|underline|visible|w|whitespace|z)(?:-|$)/;

/** A hand-rolled kebab class (`siu-approval-head`) or a BEM-ish token. */
const CLASS_LIKE = /^[a-z][a-z0-9]*(?:-[a-z0-9[\]]+)+$/;

/** SVG `d=` path data, which is a long run of coordinates and commands. */
const SVG_PATH_DATA = /^(?:[\s\d.,+-]*[MmZzLlHhVvCcSsQqTtAa][\s\d.,+-]*)+$/;

/** URL schemes, so a bare `data:` is a scheme token rather than a label. */
const URL_SCHEMES = new Set(['blob', 'chrome', 'data', 'file', 'http', 'https', 'javascript', 'mailto', 'ws', 'wss']);

/**
 * A literal that is user-visible copy rather than a class token, id, selector,
 * enum token or diagnostics string.
 *
 * Whitespace is NOT required: `'(root)'`, `'OK'` and `'Send'` are copy, and the
 * old whitespace test is exactly why they slipped through. What replaces it is
 * the non-copy vocabulary above — every rejection below names a category the
 * census actually found in this module.
 */
function looksLikeCopy(value) {
  const text = value.trim();
  if (text === '') return false;
  // A single character is a glyph, a unit or a key — never a sentence.
  if (text.length === 1) return false;
  if (!/[A-Za-z\u4e00-\u9fff]/.test(text)) return false;
  // Markup, attribute syntax, template interpolation and object braces.
  if (/[<>="`{}]/.test(text)) return false;
  // Selectors, paths, attribute names.
  if (/^(?:[./#[]|aria-|data-)/.test(text)) return false;
  // HTML entities (`&amp;`) are escapes, not copy.
  if (/^&(?:[a-zA-Z]+|#\d+);$/.test(text)) return false;
  // A URL scheme (`data:`), a bare `http:` — never a label.
  const scheme = /^([a-z][a-z0-9+.-]*):$/.exec(text);
  if (scheme && URL_SCHEMES.has(scheme[1])) return false;
  // A prefix awaiting concatenation (`badge.`, `custom-`).
  if (/^[a-z][\w.-]*[.-]$/.test(text)) return false;
  // Keyboard glyphs (`⌘N`, `⇧↵`) are platform chrome, not localized copy.
  if (/^[\u2318\u21e7\u2325\u2303\u21e9]/.test(text)) return false;
  // A concatenation fragment (`' + list + '`) captured by the per-line matcher.
  if (/^\+\s.*\s\+$/.test(text)) return false;
  // A parenthesized token such as `(prefers-color-scheme: dark)`.
  if (/^\([^()]*[:;][^()]*\)$/.test(text)) return false;
  // An HTTP path or an `a/b` pair.
  if (/^[a-z][\w.+-]*\/[\w.+-]+$/.test(text)) return false;
  // An i18n key: lowercase dotted path (`status.card.root`).
  if (/^[a-z][\w-]*(?:\.[A-Za-z0-9-]+)+$/.test(text)) return false;
  // A camelCase identifier (`activeProviderId`) — a field name, not copy.
  if (/^[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/.test(text)) return false;
  if (/siu-/.test(text)) return false;
  if (SVG_PATH_DATA.test(text)) return false;

  const tokens = text.split(/[\s,]+/).filter(Boolean).map((token) => token.replace(/[[\]]/g, ''));
  if (tokens.length === 0) return false;
  if (tokens.every((token) => UNIT_TOKENS.has(token))) return false;
  if (tokens.every((token) => KEY_NAMES.has(token))) return false;
  if (tokens.every((token) => ENUM_TOKENS.has(token) || ARIA_ROLE_NAMES.has(token))) return false;
  if (tokens.every((token) => HTML_TAGS.has(token) || ATTRIBUTE_NAMES.has(token) || EVENT_NAMES.has(token) || JS_TYPE_NAMES.has(token) || DOM_TOKEN_NAMES.has(token))) return false;
  if (tokens.every((token) => CSS_UTILITY.test(token) || CLASS_LIKE.test(token))) return false;
  return true;
}

// --- the position axis of the value/position partition ---------------------
//
// `looksLikeCopy()` classifies a literal by its VALUE alone, so every token it
// has to tolerate as a code token (`'low'`, `'off'`, `'none'`, `'n/a'`) is
// invisible no matter where it lands. That is exactly how `<option
// value="low">low</option>` and `payload.leafId || 'root'` shipped: the value
// is a legitimate enum token, so the classifier must decline it, and a
// value-only predicate can never tell the enum from the copy.
//
// Position is the missing half. `dataset.level = 'low'` and `el('span', ...,
// 'low')` hold the SAME string; only the second one reaches the screen. So the
// position axis below reports a literal only when BOTH hold:
//
//   1. it sits in a display position — the right-hand side of a
//      `textContent`/`innerHTML`/`title`/`placeholder` assignment, a
//      user-facing `setAttribute`, the text argument of `el()`, or the message
//      argument of `toast`/`systemNote`/`popoverGroupHead`; and
//   2. `looksLikeCopy()` declines it, so the check above did not already
//      report it.
//
// Neither half is useful alone: (1) without (2) reports every class token in an
// `el()` call, and (2) without (1) is the gap itself. The design-time census
// behind this shape counted a large number of such class tokens, measured when
// the axis was designed rather than on the current tree and NOT reproducible
// from this file — so no figure is restated here. The partition reports ZERO
// findings on the current clean tree while catching all three shipped defects,
// which is why this shape was chosen over widening `looksLikeCopy()`: a
// single-token detector needs an allowlist that grows with every enum, id and
// class token, whereas a display position is a property of the sink and does
// not drift as the vocabulary does.
//
// It FAILS to catch: a hardcoded literal passed to a display sink this list
// does not know (a new helper, `document.title`, a third-party toast), and a
// literal assembled into a display string outside a `tr()` call in a position
// the sink list misses. Both are misses, not false positives — the check never
// reports a token it cannot place in a display position.

/** Markup/attribute syntax: `'<span>'`, `'data-role="label"'`, `'${x}'`. */
const MARKUP_SYNTAX = /[<>{}"`]/;

/**
 * The literal is a comparison or `typeof`/`case` operand rather than a value
 * being rendered: `typeof event.result === 'string'`, `row.dataset.level ===
 * 'off'`. Those sit inside a display statement but are code, not copy.
 */
const COMPARISON_OPERAND = /(?:===|!==|==|!=|<=|>=|\btypeof|\bcase\b|\bin\b|\binstanceof)\s*$/;

/**
 * A concatenation fragment (`' + ws.arch + '`) that the per-line literal
 * matcher produces when a string containing an escape splits a statement. It is
 * an artefact of the matcher, not a literal in the source, and
 * `looksLikeCopy()` already declines it for the same reason.
 */
const CONCATENATION_FRAGMENT = /^\+\s.*\s\+$/;

/** Assignment targets whose right-hand side reaches the screen. */
const DISPLAY_PROPERTIES = ['textContent', 'innerHTML', 'placeholder', 'title'];

/** `setAttribute` names whose value is read by a human (or a screen reader). */
const DISPLAY_ATTRIBUTES = ['aria-label', 'aria-description', 'title', 'placeholder'];

/** Calls whose first argument is rendered text rather than a token. */
const DISPLAY_CALLS = ['toast', 'systemNote', 'popoverGroupHead'];

/**
 * Blank every `tr(...)` span, preserving newlines so line numbers hold.
 *
 * Everything inside those spans IS the localization, so leaving it in place
 * would report `tr('settings.providers.apiKey.unset')` as an unlocalized
 * literal. Blanking also collapses nested calls to whitespace, which keeps the
 * window readers below from having to understand call syntax.
 */
function maskTrCalls(code) {
  const chars = [...code];
  for (const match of code.matchAll(/(?<![A-Za-z0-9_$.])tr\s*\(/g)) {
    let depth = 0;
    let end = code.length - 1;
    for (let i = match.index + match[0].length - 1; i < code.length; i += 1) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    for (let i = match.index; i <= end; i += 1) if (chars[i] !== '\n') chars[i] = ' ';
  }
  return chars.join('');
}

/** Read a balanced `open`…`close` group, ignoring quotes and escapes. */
function readBalanced(code, start, open, close) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < code.length; i += 1) {
    const ch = code[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      if (depth === 0) return code.slice(start, i);
      depth -= 1;
    }
  }
  return code.slice(start);
}

/**
 * Read a statement's right-hand side from `start` to the end of its statement.
 *
 * The window has to span lines: the workstation tooltip is one assignment whose
 * labels (`'OS: '`, `'Arch: '`) sit on continuation lines joined by `+`, and a
 * per-line reader missed exactly those. It also has to stop at the end of the
 * statement, or the window swallows the next function's literals.
 */
function readStatement(code, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < code.length; i += 1) {
    const ch = code[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return code.slice(start, i);
      depth -= 1;
    } else if (ch === ';' && depth === 0) return code.slice(start, i);
    else if (ch === '\n' && depth === 0 && !/[+\-*/%<>=!&|?:,.([{]\s*$/.test(code.slice(start, i).trimEnd())) {
      return code.slice(start, i);
    }
  }
  return code.slice(start);
}

/** Split a call's argument list on top-level commas. */
function splitArguments(body) {
  const args = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (ch === '\\') {
        current += body[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      args.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  args.push(current);
  return args;
}

/**
 * Every literal in `code` that reaches the screen but that `looksLikeCopy()`
 * declines. Returns `{ value, line, sink }` records, deduplicated.
 */
function displayPositionLiterals(code) {
  const masked = maskTrCalls(code);
  const lineAt = (index) => masked.slice(0, index).split('\n').length;
  const windows = [];

  const propertyPattern = new RegExp(`\\.(?:${DISPLAY_PROPERTIES.join('|')})\\s*=\\s*`, 'g');
  for (const match of masked.matchAll(propertyPattern)) {
    windows.push({ sink: 'assignment', text: readStatement(masked, match.index + match[0].length), line: lineAt(match.index) });
  }

  const attributePattern = /setAttribute\(\s*'([^']+)'\s*,/g;
  for (const match of masked.matchAll(attributePattern)) {
    if (DISPLAY_ATTRIBUTES.includes(match[1])) {
      windows.push({ sink: 'setAttribute', text: readBalanced(masked, match.index + match[0].length, '(', ')'), line: lineAt(match.index) });
    }
  }

  for (const name of DISPLAY_CALLS) {
    const callPattern = new RegExp(`(?<![A-Za-z0-9_$.])${name}\\s*\\(`, 'g');
    for (const match of masked.matchAll(callPattern)) {
      const args = splitArguments(readBalanced(masked, match.index + match[0].length, '(', ')'));
      windows.push({ sink: name, text: args[0] ?? '', line: lineAt(match.index) });
    }
  }

  const elPattern = /(?<![A-Za-z0-9_$.])el\s*\(/g;
  for (const match of masked.matchAll(elPattern)) {
    const args = splitArguments(readBalanced(masked, match.index + match[0].length, '(', ')'));
    if (args.length >= 3) windows.push({ sink: 'el', text: args[2], line: lineAt(match.index) });
  }

  const found = new Map();
  for (const window of windows) {
    for (const literal of window.text.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g)) {
      const value = literal[1] ?? literal[2];
      if (!/[A-Za-z]/.test(value)) continue;
      if (MARKUP_SYNTAX.test(value)) continue;
      if (CONCATENATION_FRAGMENT.test(value.trim())) continue;
      if (COMPARISON_OPERAND.test(window.text.slice(0, literal.index))) continue;
      if (looksLikeCopy(value)) continue;
      const key = `${JSON.stringify(value)} (${window.sink}, region line ${window.line})`;
      if (!found.has(key)) found.set(key, key);
    }
  }
  return [...found.values()];
}

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  → ${detail}` : ''}`);
}

/**
 * The sets a bare token can belong to. Named once so the failure message below
 * can point at the extension point instead of leaving the reader to find it.
 */
const VOCABULARY_SETS = {
  ENUM_TOKENS,
  ARIA_ROLE_NAMES,
  UNIT_TOKENS,
  KEY_NAMES,
  DOM_TOKEN_NAMES,
  HTML_TAGS,
  ATTRIBUTE_NAMES,
  EVENT_NAMES,
  JS_TYPE_NAMES
};

/**
 * Annotate a value-axis finding whose literal is a bare, whitespace-free token.
 *
 * The value axis is position-blind, so an unknown bare token (`'compact'`,
 * `'polite'`) is reported even inside a comparison — deliberately, because a
 * token the vocabulary does not recognize is data-or-copy and only the
 * developer can say which. That is the guard's conservative default, and the
 * one-line fix is to name the token: adding it to a vocabulary set below hands
 * it to the position axis, which still reports it in every display sink. The
 * finding must therefore say where to add it, or the friction reads as a false
 * positive and the next person loosens the predicate instead.
 */
function vocabularyHint(entries) {
  return entries.map((entry) => {
    const match = /^"((?:[^"\\]|\\.)*)"/.exec(entry);
    let token = '';
    if (match) {
      try {
        token = JSON.parse(`"${match[1]}"`);
      } catch {
        token = '';
      }
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(token)) return entry;
    const owners = Object.keys(VOCABULARY_SETS).join(' / ');
    return `${entry}  (unknown bare token: if it is data rather than copy, add it to ${owners} — the position axis still reports it in every display sink)`;
  });
}

// --- extract the region under guard -----------------------------------------

const html = fs.readFileSync(HTML_PATH, 'utf-8');
const moduleMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!moduleMatch) {
  console.error('FAIL  index.html has no inline type="module" script');
  process.exit(1);
}
const moduleBody = moduleMatch[1];

// Each region is extracted, sized and scanned independently, so a failure
// names the region it came from instead of a single opaque blob. `minLines` is
// the vacuous-pass floor: an extractor that silently finds nothing would make
// every literal check below trivially green, so each region must be at least
// as large as the code it is known to contain.
const REGIONS = [
  { label: 'settings/provider', names: SETTINGS_FUNCTIONS, minLines: 150 },
  { label: 'composer toolbar', names: COMPOSER_FUNCTIONS, minLines: 260 },
  { label: 'session/status renderers', names: SESSION_FUNCTIONS, minLines: 160 },
  { label: 'transcript/approval renderers', names: TRANSCRIPT_FUNCTIONS, minLines: 500 },
  { label: 'chrome/palette/history renderers', names: CHROME_FUNCTIONS, minLines: 150 }
];

/**
 * Extract one region from `source` and report its defects. Split out from the
 * loop below so the self-test can run the exact same pipeline — extraction,
 * comment stripping, literal matching and detection — against a synthetic
 * module body, rather than testing the detectors in isolation.
 */
function scanRegion(source, { label, names }) {
  const parts = names.map((name) => extractFunction(source, name));
  const missing = names.filter((name, index) => !parts[index]);
  const region = parts.filter(Boolean).join('\n');
  const code = stripComments(region);
  const literals = stringLiterals(code);
  return {
    label,
    code,
    lines: region.split('\n').length,
    missing,
    cjk: [...new Set(literals.filter((l) => /[\u4e00-\u9fff]/.test(l.value)).map((l) => l.value))],
    unlocalized: [
      ...new Set(
        literals
          .filter((l) => looksLikeCopy(l.value))
          .map((l) => `${JSON.stringify(l.value)} (region line ${l.line})`)
      )
    ],
    displayPosition: displayPositionLiterals(code)
  };
}

// --- the checks -------------------------------------------------------------

const scanned = REGIONS.map((region) => {
  const { label, missing, lines, cjk, unlocalized, displayPosition, code } = scanRegion(moduleBody, region);
  check(`every guarded ${label} function is present`, missing.length === 0, missing.join(', ') || `${region.names.length} functions`);
  check(`extraction captured a real ${label} region`, lines > region.minLines, `${lines} lines (floor > ${region.minLines})`);
  check(`no hardcoded Chinese literal in the ${label} region`, cjk.length === 0, cjk.join(' | ') || 'clean');
  check(`no hardcoded English copy in the ${label} region`, unlocalized.length === 0, vocabularyHint(unlocalized).join(' | ') || 'clean');
  check(`no unlocalized literal in a display position in the ${label} region`, displayPosition.length === 0, displayPosition.join(' | ') || 'clean');
  return { label, code, lines };
});

const totalLines = scanned.reduce((sum, s) => sum + s.lines, 0);
// The floor follows the region count: with five regions the smallest honest
// total is the sum of the per-region floors (150+260+160+500+150 = 1220).
check('extraction captured the full guarded region', totalLines > 1220, `${totalLines} lines across ${scanned.length} regions`);

const settingsCode = scanned[0].code;
const code = scanned.map((s) => s.code).join('\n');

// The specific regression: the key placeholder must be interpolated, never
// concatenated, or the Chinese UI shows "sk-••••1234 (unchanged)".
check(
  'key placeholder interpolates its suffix via tr()',
  /tr\(\s*'settings\.providers\.apiKey\.unchanged'\s*,\s*\{\s*masked:/.test(settingsCode),
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
// Accept both quote styles: an en value containing an apostrophe must be
// double-quoted, and matching only single quotes would skip it entirely —
// silently exempting it from the CJK check below.
const enEntries = [...enBlock.matchAll(/^\s*'([^']+)':\s*(?:'([^']*)'|"([^"]*)")/gm)].map((m) => ({ key: m[1], value: m[2] ?? m[3] }));
const enCjk = enEntries.filter((e) => /[\u4e00-\u9fff]/.test(e.value) && !BILINGUAL_KEYS.has(e.key));
check('no CJK leaked into the en table', enCjk.length === 0, enCjk.map((e) => e.key).join(', ') || 'clean');
check('bilingual notify titles are still bilingual', enEntries.filter((e) => BILINGUAL_KEYS.has(e.key)).every((e) => /[\u4e00-\u9fff]/.test(e.value)));

// Every tr() key referenced in the guarded regions must exist in both tables.
const referenced = [...new Set([...code.matchAll(/tr\(\s*'([^']+)'/g)].map((m) => m[1]))].filter((k) => !k.endsWith('.'));
const unresolved = referenced.filter((k) => !zhKeys.has(k) || !enKeys.has(k));
check('every tr() key in the guarded regions is defined in both tables', unresolved.length === 0, unresolved.join(', ') || `${referenced.length} keys checked`);

// --- notifications.js: the second served module ------------------------------
//
// `index.html` loads this file through its own `<script type="module" src>`, so
// it is served to the browser and the copy it produces reaches the screen — but
// it is NOT part of the inline module every check above reads, so five rounds of
// auditing it left the file entirely unguarded. It gets the three axes that are
// clean on it and only those: the value axis is EXCLUDED here by the scope
// decision documented in the header, because its vocabulary was calibrated on
// `index.html` and this file's Web Audio / CSS domain trips it 37 times (23
// distinct literals) on clean code.
//
// The floors below are the vacuous-pass guard for the whole-file read: if
// `stripComments` + `stringLiterals` were to find nothing, the CJK and position
// checks would both pass trivially. They follow the margin the per-region floors
// use (measured across the five regions: 23–30% below their real sizes; the
// full-region floor is 28% below) — this file measures 806 lines after comment
// stripping and 155 literals, so its floors sit 26% and 29% below respectively,
// and a truncation or a silent read failure fails loudly instead of going green.

/** Minimum comment-stripped line count of notifications.js (measured 806). */
const NOTIFICATIONS_MIN_LINES = 600;
/** Minimum literal count of notifications.js (measured 155). */
const NOTIFICATIONS_MIN_LITERALS = 110;

/**
 * Scan a standalone served module with the axes that are usable on it.
 *
 * The pipeline is deliberately the SAME one `scanRegion` runs — the shared
 * `stripComments`, the shared `stringLiterals` extractor and the shared
 * `displayPositionLiterals` — so a CJK or a position finding here means exactly
 * what it means for the inline module, and there is no second literal parser to
 * drift out of step. The only omission is the value axis, and the omission is a
 * decision (header, "SCOPE DECISION"), not an oversight.
 */
function scanModule(source) {
  const code = stripComments(source);
  const literals = stringLiterals(code);
  return {
    code,
    lines: code.split('\n').length,
    literalCount: literals.length,
    cjk: [...new Set(literals.filter((l) => /[\u4e00-\u9fff]/.test(l.value)).map((l) => l.value))],
    displayPosition: displayPositionLiterals(code)
  };
}

const notifications = scanModule(fs.readFileSync(NOTIFICATIONS_PATH, 'utf-8'));
check(
  'extraction captured a real notifications module',
  notifications.lines > NOTIFICATIONS_MIN_LINES,
  `${notifications.lines} lines after comment stripping (floor > ${NOTIFICATIONS_MIN_LINES})`
);
check(
  'the notifications module literal extraction found real content',
  notifications.literalCount > NOTIFICATIONS_MIN_LITERALS,
  `${notifications.literalCount} literals (floor > ${NOTIFICATIONS_MIN_LITERALS})`
);
check(
  'no hardcoded Chinese literal in the notifications module',
  notifications.cjk.length === 0,
  notifications.cjk.join(' | ') || 'clean'
);
check(
  'no unlocalized literal in a display position in the notifications module',
  notifications.displayPosition.length === 0,
  notifications.displayPosition.join(' | ') || 'clean'
);
// The check with the most to catch here: the module reaches the dictionary
// through its own local `tr` wrapper around `window.SuperIUi18n.t`, and a key
// the tables do not both define renders as the raw key string inside a
// notification banner. Reuses the same call-site pattern and the same table
// extraction the check above uses.
//
// The predicate below is a named helper, not an inline filter, so the self-test
// exercises THIS code path — calling a second copy would let this one rot while
// the copy stayed green, which is the same isolation error the region tests
// were restructured to avoid. `TR_CALL` is character-for-character the
// call-site pattern the check above runs inline (`/tr\(\s*'([^']+)'/g`),
// hoisted to a name so it is written once here; the region check keeps its own
// copy untouched, because rewriting an existing check to share it would alter
// a line this change has no business touching.
const TR_CALL = /tr\(\s*'([^']+)'/g;
function referencedTrKeys(codeSource) {
  return [...new Set([...codeSource.matchAll(TR_CALL)].map((m) => m[1]))].filter((k) => !k.endsWith('.'));
}
function unresolvedTrKeys(codeSource) {
  return referencedTrKeys(codeSource).filter((k) => !zhKeys.has(k) || !enKeys.has(k));
}
const notifyReferenced = referencedTrKeys(notifications.code);
const notifyUnresolved = unresolvedTrKeys(notifications.code);
check(
  'every tr() key referenced by the notifications module is defined in both tables',
  notifyUnresolved.length === 0,
  notifyUnresolved.join(', ') || `${notifyReferenced.length} keys checked`
);

// --- static markup: text that no render function ever rewrites ---------------
//
// Every check above reads only the inline `<script type="module">`. A literal
// hardcoded in the static markup is invisible to all of them: it is not a JS
// string literal, so no scan of the module can see it. `#notify-label` sat as
// raw Chinese `通知` in the markup with no `data-i18n` annotation and no rewrite
// path, and five rounds of module-only auditing never noticed.
//
// The scan is report-first by design. The census that motivated it found three
// such elements. Two have since been fixed at the source: `#notify-label` now
// carries `data-i18n`, and `#set-reasoning-hint` does too — its old entry
// claimed the rewrite made it benign, which was false on the error paths where
// `/api/settings` fails and `renderReasoningHint()` never runs. Failing hard on
// a survivor would block unrelated work, so the one survivor is named in an
// allowlist with a reason, and the check fails only when a NEW unannotated
// element appears. That keeps the known finding visible in the output instead
// of silently ignored.

/**
 * Elements that carry the text-node annotation, `data-i18n`, and nothing else.
 *
 * `\b` is the wrong delimiter here: it matches between `i` and `-`, so the
 * previous `/data-i18n\b/` ALSO matched `data-i18n-title`,
 * `data-i18n-placeholder` and `data-i18n-aria-label`. An element carrying only
 * a title annotation therefore silenced the check on its own text node — a
 * false-negative generator that happened to be benign on today's tree only
 * because no such element has a text node. The lookahead requires the real
 * attribute: `data-i18n` must be followed by whitespace, `=`, or the tag end.
 */
const I18N_ATTRIBUTE = /(?:^|\s)data-i18n(?=[\s=>]|$)/;

/**
 * Text-bearing elements with no `data-i18n` annotation that are known and
 * accepted. Each entry matches either by `id` or by exact `text`.
 *
 * An entry here is a decision, not a silencing: the reason must say why the
 * element is not a localization defect. Anything not listed fails the check.
 */
const STATIC_TEXT_ALLOWLIST = [
  {
    text: 'SuperIU',
    reason: 'product name, identical in every locale'
  }
];

/** Blank an element's content while preserving newlines, so line numbers hold. */
function blankElementContent(source, tag) {
  return source.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), (block) => block.replace(/[^\n]/g, ' '));
}

/** Tag names that have no closing tag, so the walker must not push them. */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/**
 * Walk the static markup once, reporting every text node and every tag.
 *
 * The module's own JS is blanked first: it is full of strings that look like
 * tags (`'<select>'`, `'<li>'`), and parsing those as markup invents elements
 * that do not exist in the document.
 *
 * Both scans below (text nodes, attribute values) share this one walker and
 * its element stack. Two copies of the token pattern would drift, and a tag the
 * text scan sees but the attribute scan does not is exactly the kind of gap
 * this guard exists to close.
 */
function walkMarkup(source, visit) {
  const markup = blankElementContent(blankElementContent(source, 'script'), 'style');
  const tokenPattern = /<!--[\s\S]*?-->|<\/([A-Za-z][\w:-]*)\s*>|<([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;
  const stack = [];
  let cursor = 0;
  let match;
  while ((match = tokenPattern.exec(markup))) {
    const text = markup.slice(cursor, match.index);
    const line = markup.slice(0, match.index).split('\n').length;
    if (/[A-Za-z\u4e00-\u9fff]/.test(text) && text.trim()) {
      visit.text({ text: text.trim(), line, parent: stack[stack.length - 1] });
    }
    cursor = match.index + match[0].length;
    if (match[0].startsWith('<!--')) continue;
    if (match[1]) {
      const name = match[1].toLowerCase();
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const name = match[2].toLowerCase();
    const attrs = match[3] || '';
    const selfClosing = VOID_TAGS.has(name) || /\/>$/.test(match[0]);
    visit.tag({ name, attrs, line, selfClosing });
    if (!selfClosing) stack.push({ name, attrs });
  }
}

/** Every text node in the static markup, attributed to its parent element. */
function staticTextNodes(source) {
  const nodes = [];
  walkMarkup(source, { text: (node) => nodes.push(node), tag: () => {} });
  return nodes;
}

/** Attribute value of a tag's attribute string, or ''. Handles both quote styles. */
function attributeOf(attrs, name) {
  const match = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return match ? match[1] ?? match[2] : '';
}

/**
 * Whether `attrs` carries the attribute `name` exactly — not merely a longer
 * attribute that starts with it. `\b` is wrong for a hyphenated name: it
 * matches between `i18n` and `-`, so a prefix test would accept
 * `data-i18n-title` as `data-i18n`.
 */
function hasAttribute(attrs, name) {
  return new RegExp(`(?:^|\\s)${name}(?=[\\s=>]|$)`).test(attrs);
}

const staticNodes = staticTextNodes(html);
const annotatedCount = staticNodes.filter((node) => I18N_ATTRIBUTE.test(node.parent?.attrs || '')).length;
// Non-vacuous floors: a scanner that found nothing (or found only annotated
// nodes) would make the findings check below trivially green.
check('static markup scan found text-bearing elements', staticNodes.length > 30, `${staticNodes.length} text nodes`);
check('static markup scan found data-i18n annotations', annotatedCount > 40, `${annotatedCount} annotated nodes`);

const unannotated = staticNodes
  .filter((node) => node.parent && !I18N_ATTRIBUTE.test(node.parent.attrs))
  .map((node) => ({
    id: attributeOf(node.parent.attrs, 'id'),
    text: node.text,
    line: node.line,
    tag: node.parent.name
  }));

for (const finding of unannotated) {
  const known = STATIC_TEXT_ALLOWLIST.find((entry) => (entry.id && entry.id === finding.id) || (!entry.id && entry.text === finding.text));
  const where = finding.id ? `#${finding.id}` : `<${finding.tag}>`;
  console.log(
    `${known ? 'INFO' : 'FAIL'}  static markup text without data-i18n  →  ${where} line ${finding.line}: ${JSON.stringify(finding.text)}${known ? `  (allowed: ${known.reason})` : ''}`
  );
}

const unlisted = unannotated.filter(
  (finding) => !STATIC_TEXT_ALLOWLIST.some((entry) => (entry.id && entry.id === finding.id) || (!entry.id && entry.text === finding.text))
);
check(
  'every unannotated static text element is on the allowlist',
  unlisted.length === 0,
  unlisted.map((f) => `${f.id ? `#${f.id}` : `<${f.tag}>`} line ${f.line}`).join(', ') || `${unannotated.length} known, all allowed`
);

// --- static markup: copy-bearing attributes ----------------------------------
//
// The text-node scan above reads only what sits BETWEEN tags. A hardcoded
// string in an attribute is invisible to it: `<input placeholder="Search every
// model">` has no text node at all, so the whole element never enters the scan.
// That is a structural blind spot of the same shape as the module-only scan the
// text check was added to close — proven by planting that exact tag, which left
// the guard green while the same string as a text node failed it.
//
// The three attributes below are the ones a human reads. Each has a matching
// annotation form that `i18n.js`'s `apply()` handles, so the requirement is
// concrete: a copy-bearing attribute value must carry its `data-i18n-*` sibling
// on the same element.

/** Copy-bearing attributes and the annotation that covers each. */
const COPY_ATTRIBUTES = [
  ['placeholder', 'data-i18n-placeholder'],
  ['title', 'data-i18n-title'],
  ['aria-label', 'data-i18n-aria-label']
];

/**
 * Copy-bearing attribute values with no matching annotation that are known and
 * accepted. Each entry matches by element id and attribute name.
 */
const STATIC_ATTRIBUTE_ALLOWLIST = [
  {
    id: 'set-api-key',
    attr: 'placeholder',
    reason: 'credential format hint (`sk-…`), not prose: the same token in every locale'
  },
  {
    id: 'set-base-url',
    attr: 'placeholder',
    reason: 'an example URL (`https://api.openai.com/v1`), not prose: the same token in every locale'
  }
];

/**
 * Every copy-bearing attribute value in `source` that lacks its matching
 * `data-i18n-*` annotation, plus the counts the non-vacuous floors need.
 * Returns findings for the caller to filter against the allowlist, so the
 * self-test drives this exact function rather than a re-implementation.
 */
function staticCopyAttributes(source) {
  const findings = [];
  let copyCount = 0;
  let annotatedCount = 0;
  walkMarkup(source, {
    text: () => {},
    tag: ({ name, attrs, line }) => {
      for (const [attr, annotation] of COPY_ATTRIBUTES) {
        const value = attributeOf(attrs, attr);
        if (!value || !looksLikeCopy(value)) continue;
        copyCount += 1;
        if (hasAttribute(attrs, annotation)) {
          annotatedCount += 1;
          continue;
        }
        findings.push({ id: attributeOf(attrs, 'id'), tag: name, attr, value, line });
      }
    }
  });
  return { findings, copyCount, annotatedCount };
}

const { findings: attributeFindings, copyCount: copyAttributeCount, annotatedCount: annotatedAttributeCount } = staticCopyAttributes(html);
// Non-vacuous floors: the census that motivated this check found 46 copy-bearing
// attributes, 44 of them annotated (as of the current run; both counts move as
// the markup does). A scanner that walked no tags would report zero findings and
// look green, so both halves are pinned.
check('static attribute scan found copy-bearing attributes', copyAttributeCount > 30, `${copyAttributeCount} attributes`);
check('static attribute scan found data-i18n-* annotations', annotatedAttributeCount > 30, `${annotatedAttributeCount} annotated attributes`);

for (const finding of attributeFindings) {
  const known = STATIC_ATTRIBUTE_ALLOWLIST.find((entry) => entry.id === finding.id && entry.attr === finding.attr);
  const where = finding.id ? `#${finding.id}` : `<${finding.tag}>`;
  console.log(
    `${known ? 'INFO' : 'FAIL'}  static markup attribute without data-i18n-${finding.attr}  →  ${where} line ${finding.line}: ${finding.attr}=${JSON.stringify(finding.value)}${known ? `  (allowed: ${known.reason})` : ''}`
  );
}

const unlistedAttributes = attributeFindings.filter(
  (finding) => !STATIC_ATTRIBUTE_ALLOWLIST.some((entry) => entry.id === finding.id && entry.attr === finding.attr)
);
check(
  'every unannotated copy-bearing attribute is on the allowlist',
  unlistedAttributes.length === 0,
  unlistedAttributes.map((f) => `${f.id ? `#${f.id}` : `<${f.tag}>`} ${f.attr} line ${f.line}`).join(', ') || `${attributeFindings.length} known, all allowed`
);

// --- whole-file key resolution: the two blind spots the region scan leaves ---
//
// Every `tr()` check above reads either the five REGIONS or `notifications.js`,
// and the region list covers 61 of the module's functions. A `tr()` call
// anywhere else in `index.html` was therefore invisible: planting
// `tr('palette.quitZZZ')` at line 6179 — inside the module, outside every
// region — left this guard green, while the identical call inside a region
// failed. The `data-i18n*` attributes have the mirror-image hole: the static
// checks above assert that an annotation EXISTS on a copy-bearing element
// (`hasAttribute`), and never resolve the VALUE it carries, so
// `data-i18n="settings.themeZZZ"` at line 3481 was equally invisible.
//
// Both are closed by resolving the key, not by widening the region list. The
// region list is a scope decision that has to be re-derived whenever the module
// is refactored; a whole-file scan cannot fall behind the code it covers. The
// extraction is deliberately the file's EXISTING pair — `stripComments` and the
// same `TR_CALL` call-site pattern the region and notifications checks run —
// plus the same `walkMarkup`/`attributeOf` pair the static attribute checks
// share, so there is no second literal parser and no second markup walker to
// drift out of step.

/** A dictionary key: dot-separated segments. All 298 keys match this shape. */
const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/;

/** A literal carrying a template placeholder is assembled copy, not a key. */
const KEY_PLACEHOLDER = /[{}$%]/;

/** The four annotation attributes whose VALUE `i18n.js`'s `apply()` resolves. */
const I18N_VALUE_ATTRIBUTES = ['data-i18n', 'data-i18n-title', 'data-i18n-placeholder', 'data-i18n-aria-label'];

/**
 * Every distinct `tr()` literal in `source` that names a dictionary key, plus
 * the literals the key filter excluded.
 *
 * Three classes are excluded, and each is a literal that cannot name a key:
 *   - a trailing-dot prefix (`'badge.'` in `tr('badge.' + status)`) is a dynamic
 *     call the call-site pattern cannot resolve;
 *   - a literal carrying a template placeholder (`{n}`, `$x`) is assembled;
 *   - anything that is not `segment.segment` key-shaped.
 * The filter is narrow by construction: all 298 dictionary keys are
 * `segment.segment`, so a real missing key is never excluded — it is reported.
 * The excluded set is returned rather than dropped, so the output can state it
 * instead of leaving the exemption to be inferred from a lower count.
 */
function trKeySites(source) {
  const code = stripComments(source);
  // Line numbers come from the RAW source, not from `code`. `stripComments`
  // deletes the newlines its `//` rule swallows along with the comment, so an
  // offset into `code` maps to a file line that is off by however many comment
  // lines precede it (measured: 68 lines on today's index.html, which put a
  // planted defect at line 6135 instead of its real 6179). The KEY SET still
  // comes from `code`, so a `tr()` inside a comment cannot fail the check —
  // only the attribution moves.
  const rawLines = new Map();
  for (const match of source.matchAll(TR_CALL)) {
    if (!rawLines.has(match[1])) rawLines.set(match[1], source.slice(0, match.index).split('\n').length);
  }
  const sites = new Map();
  const excluded = new Map();
  for (const match of code.matchAll(TR_CALL)) {
    const key = match[1];
    const line = rawLines.get(key) ?? code.slice(0, match.index).split('\n').length;
    const why = key.endsWith('.')
      ? 'dynamic prefix'
      : KEY_PLACEHOLDER.test(key)
        ? 'template placeholder'
        : !KEY_SHAPE.test(key)
          ? 'not key-shaped'
          : null;
    if (why) {
      if (!excluded.has(key)) excluded.set(key, { key, line, why });
      continue;
    }
    if (!sites.has(key)) sites.set(key, { key, line });
  }
  return { sites: [...sites.values()], excluded: [...excluded.values()] };
}

/**
 * Every distinct `data-i18n*` attribute VALUE in `source`'s static markup, with
 * the attribute it came from.
 *
 * No key filter is applied here, deliberately: an annotation value is always a
 * literal key — nothing assembles one at runtime, the module only ever DELETES
 * `dataset.i18nAriaLabel` — so a value that is not key-shaped is a defect to
 * report, not a shape to skip. `attributeOf` matches `data-i18n` exactly (it
 * requires the `=`), so `data-i18n-title` is not mistaken for `data-i18n`.
 */
function i18nValueSites(source) {
  const sites = new Map();
  walkMarkup(source, {
    text: () => {},
    tag: ({ attrs, line }) => {
      for (const name of I18N_VALUE_ATTRIBUTES) {
        const value = attributeOf(attrs, name);
        if (value && !sites.has(value)) sites.set(value, { key: value, line, attr: name });
      }
    }
  });
  return [...sites.values()];
}

/** Sites whose key is absent from either table. Shared by all three checks. */
function unresolvedSites(sites) {
  return sites.filter((site) => !zhKeys.has(site.key) || !enKeys.has(site.key));
}

const htmlTrSites = trKeySites(html);
const notificationsTrSites = trKeySites(fs.readFileSync(NOTIFICATIONS_PATH, 'utf-8'));
const dataI18nValues = i18nValueSites(html);

// Vacuous-pass floors. Measured on the clean tree: 125 key sites in
// `index.html` (128 distinct literals minus the 3 dynamic prefixes), 7 in
// `notifications.js`, and 129 distinct `data-i18n*` values. Each floor sits
// about 12% below its measurement, so a whole-file scan that silently returns
// nothing — the failure mode a whole-file check is most exposed to — fails
// loudly instead of passing over zero keys.
const WHOLE_FILE_TR_FLOOR = 110;
const NOTIFICATIONS_TR_FLOOR = 6;
const I18N_VALUE_FLOOR = 110;

check(
  'whole-file tr() scan found key sites in index.html',
  htmlTrSites.sites.length > WHOLE_FILE_TR_FLOOR,
  `${htmlTrSites.sites.length} keys (floor > ${WHOLE_FILE_TR_FLOOR})`
);
check(
  'whole-file tr() scan found key sites in notifications.js',
  notificationsTrSites.sites.length > NOTIFICATIONS_TR_FLOOR,
  `${notificationsTrSites.sites.length} keys (floor > ${NOTIFICATIONS_TR_FLOOR})`
);
check('data-i18n* scan found key values', dataI18nValues.length > I18N_VALUE_FLOOR, `${dataI18nValues.length} values (floor > ${I18N_VALUE_FLOOR})`);

// The excluded set is reported further down, after the dynamic-prefix family
// checks — because whether an exclusion is an exemption or a covered case is
// only known once those have run. See the family section below.

const htmlTrUnresolved = unresolvedSites(htmlTrSites.sites);
check(
  'every tr() key literal in index.html resolves in both tables',
  htmlTrUnresolved.length === 0,
  htmlTrUnresolved.map((s) => `${s.key} (line ${s.line})`).join(', ') || `${htmlTrSites.sites.length} keys checked`
);

const notificationsTrUnresolved = unresolvedSites(notificationsTrSites.sites);
check(
  'every tr() key literal in notifications.js resolves in both tables',
  notificationsTrUnresolved.length === 0,
  notificationsTrUnresolved.map((s) => `${s.key} (line ${s.line})`).join(', ') || `${notificationsTrSites.sites.length} keys checked`
);

const i18nValueUnresolved = unresolvedSites(dataI18nValues);
check(
  'every data-i18n* attribute value resolves in both tables',
  i18nValueUnresolved.length === 0,
  i18nValueUnresolved.map((s) => `${s.key} (${s.attr}, line ${s.line})`).join(', ') || `${dataI18nValues.length} values checked`
);


// --- dynamic-prefix families: enumerate the value set, then resolve it -------
//
// The checks above resolve `tr()` literals, and three of those literals are
// trailing-dot prefixes: `'badge.'`, `'status.'` and `'composer.effort.'` are
// concatenated with a runtime value before they name a key, so the literal
// alone cannot be resolved and the whole-file scan must skip it. That skip was
// a PROVEN blind spot, not a theoretical one: planting
// `tr('badgeZZZ.' + status)` in index.html left both guards green (EXIT 0).
// Dynamic/enum-driven keys are precisely where this repo has leaked before — a
// `RiskLevel` enum and an `AutoReviewMode` enum both reached users raw.
//
// The remedy is to resolve the ASSEMBLED key instead of exempting the prefix.
// For each family the value set is not hardcoded here: it is parsed out of the
// exact expression that guards the call site — the `known` list inside
// `statusBadge()`, `STATUS_IDS`, and `EFFORT_LEVELS` — so a value added to the
// producer is checked against the tables without anyone remembering to update
// this file, and a producer that is renamed or deleted FAILS loudly rather
// than silently yielding an empty set.
//
// The extraction is the file's EXISTING parser, not a new one: `stripComments`
// blanks comments in place (preserving newlines), the producer statement is
// read with the same brace-walking `readBalanced` that `displayPositionLiterals`
// uses for `setAttribute`, and its array is read with the same
// `stringLiterals` matcher every other literal check uses.

/**
 * One dynamic-prefix family: the trailing-dot literal, the producer whose value
 * set feeds it, and the vacuous-pass floor for that value set.
 *
 * `producer` is the literal source text that precedes the array in the module
 * body, and `guard` is the expression that must gate the call site — the
 * `includes` check that keeps an unknown runtime value away from `tr()`. Both
 * are asserted, so a refactor that moves the list, or drops the guard and
 * starts interpolating arbitrary values into a key, is reported rather than
 * silently unguarded.
 */
const DYNAMIC_KEY_FAMILIES = [
  {
    prefix: 'badge.',
    producer: 'const known = ',
    guard: 'known.includes(status)',
    minValues: 4,
    where: 'statusBadge()'
  },
  {
    prefix: 'status.',
    producer: 'const STATUS_IDS = ',
    guard: 'STATUS_IDS.includes(status)',
    minValues: 6,
    where: 'statusLabel()'
  },
  {
    prefix: 'composer.effort.',
    producer: 'const EFFORT_LEVELS = ',
    guard: 'EFFORT_LEVELS.includes(level)',
    minValues: 2,
    where: 'effortLevelLabel()'
  }
];

/**
 * The string values of the array literal that `producer` is assigned, or
 * `null` when the producer cannot be found or does not carry an array.
 *
 * `null` is deliberately distinct from `[]`: an empty array is a producer that
 * declares nothing, which the floor below reports, while `null` is a producer
 * this check could not locate at all — a refactor, not a value set. Both fail,
 * with different messages, so the reader knows whether to fix the list or this
 * extractor.
 */
function producerValues(code, producer) {
  const source = stripComments(code);
  const at = source.indexOf(producer);
  if (at === -1) return null;
  const open = source.indexOf('[', at + producer.length);
  if (open === -1) return null;
  // Guard against finding an array that belongs to a LATER statement: the `[`
  // must precede the end of the assignment's own line.
  const lineEnd = source.indexOf('\n', at);
  if (lineEnd !== -1 && open > lineEnd) return null;
  // `readBalanced` is entered INSIDE the group and stops at the unbalanced
  // close — that is how `displayPositionLiterals` calls it for `setAttribute`
  // (one past the `(`). Enter one past the `[` and re-add it.
  const inner = readBalanced(source, open + 1, '[', ']');
  // `readBalanced` returns the rest of the source when it finds no close, which
  // would make an unterminated read look like a successful one. All three real
  // producers declare their array on one line, so an inner span that crosses a
  // newline is a failed read rather than a value set.
  if (inner.includes('\n')) return null;
  const array = `[${inner}]`;
  if (!array.endsWith(']')) return null;
  return stringLiterals(array).map((literal) => literal.value);
}

/**
 * One family's expansion result: the assembled keys, the unresolved subset, and
 * the failures of the extraction itself.
 *
 * `problems` carries the two loud-failure conditions — a producer that could
 * not be found and a producer that yielded no values — so the self-test can
 * assert them through this same function instead of a copy of the logic.
 */
function expandFamily(code, family, zhTable, enTable) {
  const values = producerValues(code, family.producer);
  const problems = [];
  if (values === null) problems.push(`producer ${JSON.stringify(family.producer)} not found`);
  const list = values ?? [];
  if (values !== null && list.length === 0) problems.push(`producer ${JSON.stringify(family.producer)} yielded 0 values`);
  if (values !== null && list.length < family.minValues) {
    problems.push(`producer yielded ${list.length} values (floor ${family.minValues})`);
  }
  const sites = list.map((value) => ({ key: family.prefix + value, value }));
  const unresolved = sites.filter((site) => !zhTable.has(site.key) || !enTable.has(site.key));
  return { values: list, sites, unresolved, problems };
}

/**
 * The excluded dynamic prefixes that no family actually expands. A named helper
 * rather than an inline filter so the self-test exercises THIS code path; a
 * second copy would let this one rot while the copy stayed green.
 */
function uncoveredDynamicPrefixes(excluded, covered) {
  return excluded.filter((prefix) => !covered.has(prefix));
}

const familyResults = DYNAMIC_KEY_FAMILIES.map((family) => ({ family, ...expandFamily(moduleBody, family, zhKeys, enKeys) }));

// The guard expression each call site must keep: an `includes` test that stops
// an unknown runtime value from reaching `tr()`. Asserted on the RAW module
// body (not the comment-stripped one) so a commented-out guard is not counted,
// and anchored to the token IMMEDIATELY preceding `tr(` so a guard that merely
// sits somewhere nearby does not satisfy it.
for (const { family } of familyResults) {
  const at = moduleBody.indexOf(`tr('${family.prefix}' + `);
  const before = at === -1 ? '' : moduleBody.slice(Math.max(0, at - 200), at).trimEnd();
  check(
    `dynamic family ${JSON.stringify(family.prefix)} call site is still guarded by its value list`,
    at !== -1 && before.endsWith(`${family.guard} ?`),
    at === -1
      ? `no tr('${family.prefix}' + ...) call site found`
      : `${family.where}: expected ${family.guard} ? tr(...), preceding text ${JSON.stringify(before.slice(-60))}`
  );
}

for (const { family, values, unresolved, problems } of familyResults) {
  check(
    `dynamic family ${JSON.stringify(family.prefix)} producer was located and yielded values`,
    problems.length === 0,
    problems.join('; ') || `${values.length} values from ${JSON.stringify(family.producer)} (floor ${family.minValues})`
  );
  check(
    `every ${JSON.stringify(family.prefix)} expansion from ${family.where} resolves in both tables`,
    unresolved.length === 0,
    unresolved.map((site) => `${site.key} (from ${JSON.stringify(site.value)})`).join(', ') ||
      `${values.length} keys checked: ${values.map((v) => family.prefix + v).join(', ')}`
  );
}

// A prefix is "covered" only if a family actually ran and produced values, so
// the INFO line below cannot claim coverage that no check performed. The
// families are checked in the loop above, so a family that failed to expand
// has already failed loudly; this set only decides how the exclusion is
// REPORTED.
const coveredPrefixes = new Set(
  familyResults.filter((r) => r.problems.length === 0 && r.values.length > 0).map((r) => r.family.prefix)
);

// The exclusions are reported, not merely applied: an exemption nobody can see
// is how a narrow filter turns into a blind spot. The three dynamic prefixes
// are no longer exempt — each is covered by the family check above — so they
// are reported as COVERED, and anything else that lands in the excluded set is
// still reported as unguardable, which is what keeps this line honest.
for (const [label, sites] of [['index.html', htmlTrSites], ['notifications.js', notificationsTrSites]]) {
  const covered = sites.excluded.filter((e) => e.why === 'dynamic prefix' && coveredPrefixes.has(e.key));
  const unguardable = sites.excluded.filter((e) => !covered.includes(e));
  console.log(
    `INFO  tr() literals excluded from the whole-file scan  →  ${label} ${sites.excluded.length} ` +
      `(${sites.excluded.map((e) => `${JSON.stringify(e.key)} ${e.why}`).join(', ') || 'none'})  |  ` +
      `covered by a dynamic family: ${covered.length ? covered.map((e) => JSON.stringify(e.key)).join(', ') : 'none'}  |  ` +
      `still unguardable: ${unguardable.length ? unguardable.map((e) => `${JSON.stringify(e.key)} ${e.why}`).join(', ') : 'none'}`
  );
}

// The coverage claim above must not be inferable from a lower count, and it
// must not be able to overstate itself: EVERY dynamic prefix that lands in the
// excluded set — including one added tomorrow — has to correspond to a family
// that actually ran and produced values. Without this, adding a fourth
// `tr('theme.' + x)` call site would drop out of the whole-file scan, be
// reported as "covered" by the INFO line, and never be resolved by anything.
const excludedPrefixes = [...new Set(
  [...htmlTrSites.excluded, ...notificationsTrSites.excluded]
    .filter((e) => e.why === 'dynamic prefix')
    .map((e) => e.key)
)];
const uncoveredPrefixes = uncoveredDynamicPrefixes(excludedPrefixes, coveredPrefixes);
check(
  'every excluded dynamic prefix is covered by a real value set',
  uncoveredPrefixes.length === 0,
  uncoveredPrefixes.length
    ? `${uncoveredPrefixes.map((p) => JSON.stringify(p)).join(', ')} excluded but not expanded by any family`
    : `${excludedPrefixes.length} excluded prefix(es), all expanded: ${excludedPrefixes.map((p) => `${JSON.stringify(p)}=${familyResults.find((r) => r.family.prefix === p).values.length}`).join(', ')}`
);

// --- self-test: the checks must be able to fail ------------------------------

// Each region is re-scanned through the SAME pipeline the real check uses —
// extraction, comment stripping, literal matching, detection — against a
// synthetic module body. Testing the detectors in isolation would not prove
// that extraction reaches the region: a region dropped from REGIONS, or a
// rename that makes extractFunction return null, would still leave every real
// check green over the smaller union. So each region is rebuilt from stubs,
// a known regression is planted into one of its functions, and the scan must
// report it.
function syntheticBody(names) {
  return names.map((name) => `function ${name}() { return ${JSON.stringify(name)}; }`).join('\n');
}

{
  for (const { label, names } of REGIONS) {
    const clean = scanRegion(syntheticBody(names), { label, names });
    check(
      `self-test: the ${label} region scans clean when clean`,
      clean.missing.length === 0 && clean.cjk.length === 0 && clean.unlocalized.length === 0 && clean.displayPosition.length === 0,
      `missing=${clean.missing.length} cjk=${clean.cjk.length} copy=${clean.unlocalized.length} display=${clean.displayPosition.length}`
    );

    // The exact regression this guard exists for, planted into a function that
    // belongs to THIS region.
    const englishDefect = syntheticBody(names).replace(
      `function ${names[0]}() { return ${JSON.stringify(names[0])}; }`,
      `function ${names[0]}() { return 'x' + ' (unchanged)'; }`
    );
    const englishHit = scanRegion(englishDefect, { label, names });
    check(
      `self-test: hardcoded English copy is detectable in the ${label} region`,
      englishHit.unlocalized.some((hit) => hit.includes('(unchanged)')),
      englishHit.unlocalized.join(' | ') || 'no hit'
    );

    const cjkDefect = syntheticBody(names).replace(
      `function ${names[0]}() { return ${JSON.stringify(names[0])}; }`,
      `function ${names[0]}() { return '推理强度'; }`
    );
    const cjkHit = scanRegion(cjkDefect, { label, names });
    check(
      `self-test: a hardcoded CJK literal is detectable in the ${label} region`,
      cjkHit.cjk.length > 0,
      cjkHit.cjk.join(' | ') || 'no hit'
    );

    // The regression the positional check exists for: a single-token literal
    // that `looksLikeCopy()` must decline as an enum token, placed where it
    // reaches the screen. Planted into a function of THIS region, so a region
    // dropped from REGIONS cannot leave this green.
    const displayDefect = syntheticBody(names).replace(
      `function ${names[0]}() { return ${JSON.stringify(names[0])}; }`,
      `function ${names[0]}() { return el('span', 'siu-label', level || 'none'); }`
    );
    const displayHit = scanRegion(displayDefect, { label, names });
    check(
      `self-test: a single-token literal in a display position is detectable in the ${label} region`,
      displayHit.displayPosition.some((hit) => hit.includes('"none"')),
      displayHit.displayPosition.join(' | ') || 'no hit'
    );

    // ...and the same token in a non-display position must stay silent, or the
    // check would fire on every enum value in the module. `dataset.level` is
    // the real shape this exemption protects.
    const nonDisplayDefect = syntheticBody(names).replace(
      `function ${names[0]}() { return ${JSON.stringify(names[0])}; }`,
      `function ${names[0]}() { chip.dataset.level = level || 'none'; return chip; }`
    );
    const nonDisplayHit = scanRegion(nonDisplayDefect, { label, names });
    check(
      `self-test: the same token outside a display position is ignored in the ${label} region`,
      nonDisplayHit.displayPosition.length === 0,
      nonDisplayHit.displayPosition.join(' | ') || 'silent'
    );
  }

  // --- the two axes are a partition, and the partition is pinned ------------
  //
  // The negative control above can only ever observe the POSITION axis: it
  // plants `'none'`, which `looksLikeCopy()` declines, so the value axis is
  // silent about it by construction and the assertion would hold even if the
  // value axis were deleted outright. A test that cannot fail on the axis it
  // claims to cover proves nothing, so the value axis gets its own control.
  //
  // `'deferred'` is absent from every vocabulary set (verified by grep against
  // this file), which is the ordinary state of any token the module introduces
  // before anyone classifies it. The value axis reports it in ANY position —
  // here a pure comparison, which no position check reads. That is the guard's
  // deliberate conservative default: an unknown bare token is data-or-copy and
  // the developer must say which, by naming it in a vocabulary set.
  const VOCABULARY_MISS_TOKEN = 'deferred';
  check(
    'self-test: the vocabulary-miss token is absent from every vocabulary set',
    !Object.values(VOCABULARY_SETS).some((set) => set.has(VOCABULARY_MISS_TOKEN)) && looksLikeCopy(VOCABULARY_MISS_TOKEN),
    `${Object.keys(VOCABULARY_SETS).length} sets checked, predicate accepts it`
  );

  const vocabularyMiss = scanRegion(
    `function probe() { const mode = x(); if (mode === '${VOCABULARY_MISS_TOKEN}') return 1; return 0; }`,
    { label: 'vocabulary miss', names: ['probe'] }
  );
  check(
    'self-test: an unknown bare token is reported by the value axis in a non-display position',
    vocabularyMiss.unlocalized.some((hit) => hit.includes(`"${VOCABULARY_MISS_TOKEN}"`)) && vocabularyMiss.displayPosition.length === 0,
    `copy=${vocabularyMiss.unlocalized.join(' | ') || 'no hit'} display=${vocabularyMiss.displayPosition.length}`
  );
  // The finding must carry the one-line remedy, or it reads as a false positive
  // and invites someone to loosen the predicate instead of naming the token.
  const hinted = vocabularyHint(vocabularyMiss.unlocalized).join(' | ');
  check(
    'self-test: a bare-token value finding names the vocabulary set that resolves it',
    vocabularyMiss.unlocalized.length > 0 && Object.keys(VOCABULARY_SETS).every((name) => hinted.includes(name)),
    Object.keys(VOCABULARY_SETS).filter((name) => !hinted.includes(name)).join(', ') || 'every set named'
  );

  // The partition property, asserted in BOTH directions. An accepted literal
  // belongs to the value axis and MUST NOT be double-reported by the position
  // axis; a declined literal in a display sink belongs to the position axis and
  // MUST be reported there. Asserting one direction only would let an axis
  // silently drop its half — which is exactly the failure the existing control
  // could not see.
  const acceptedInSink = scanRegion(
    `function probe() { $('x').textContent = '(root)'; }`,
    { label: 'accepted in sink', names: ['probe'] }
  );
  const declinedInSink = scanRegion(
    `function probe() { $('x').textContent = mode || 'low'; }`,
    { label: 'declined in sink', names: ['probe'] }
  );
  check(
    'self-test: a literal the predicate accepts is reported by the value axis and not the position axis',
    looksLikeCopy('(root)') &&
      acceptedInSink.unlocalized.some((hit) => hit.includes('"(root)"')) &&
      acceptedInSink.displayPosition.length === 0,
    `copy=${acceptedInSink.unlocalized.join(' | ') || 'no hit'} display=${acceptedInSink.displayPosition.join(' | ') || 'none'}`
  );
  check(
    'self-test: a literal the predicate declines is reported by the position axis when it reaches a display sink',
    !looksLikeCopy('low') &&
      declinedInSink.displayPosition.some((hit) => hit.includes('"low"')) &&
      declinedInSink.unlocalized.length === 0,
    `copy=${declinedInSink.unlocalized.join(' | ') || 'none'} display=${declinedInSink.displayPosition.join(' | ') || 'no hit'}`
  );

  // --- no literal is lost by the partition ----------------------------------
  //
  // The end-to-end statement of the invariant. The body carries exactly the
  // literals the two axes are supposed to cover: one vocabulary-miss token, one
  // accepted copy literal, and one declined literal in a display sink. Every
  // literal must be reported by EXACTLY ONE axis. A literal in neither is
  // invisible to the guard — the defect this test exists to catch — and a
  // literal in both means the axes double-report and the "partition" claim is
  // false. The union being non-empty is asserted too, so an extractor that
  // finds nothing cannot make this pass vacuously.
  const partitionBody = `function probe() {
    const mode = x();
    const node = y();
    if (mode === '${VOCABULARY_MISS_TOKEN}') chip.dataset.level = mode;
    node.textContent = 'Save';
    node.textContent = mode || 'low';
    return mode;
  }`;
  const partition = scanRegion(partitionBody, { label: 'partition', names: ['probe'] });
  const partitionLiterals = [...new Set(stringLiterals(partition.code).map((literal) => literal.value))];
  const reportedBy = (value, entries) => entries.some((entry) => entry.startsWith(`${JSON.stringify(value)} (`));
  const buckets = partitionLiterals.map((value) => {
    const byValue = reportedBy(value, partition.unlocalized);
    const byPosition = reportedBy(value, partition.displayPosition);
    if (byValue && byPosition) return 'both';
    if (byValue) return 'value';
    if (byPosition) return 'position';
    return looksLikeCopy(value) ? 'LOST' : 'exempt';
  });
  const unionIsEmpty = partition.unlocalized.length === 0 || partition.displayPosition.length === 0;
  const unaccounted = partitionLiterals.filter((value, index) => buckets[index] !== 'value' && buckets[index] !== 'position');
  check(
    'self-test: every literal in a mixed body is accounted for by exactly one axis',
    partitionLiterals.length >= 3 && !unionIsEmpty && unaccounted.length === 0,
    `${partitionLiterals.length} literals [${buckets.join(', ')}]` +
      (unionIsEmpty ? ', union empty' : '') +
      (unaccounted.length ? `, unaccounted ${unaccounted.map((v) => JSON.stringify(v)).join(', ')}` : '')
  );

  // The third bucket is real, not a hole in the invariant above. A literal the
  // predicate declines that never reaches a sink is code: `'span'` as `el()`'s
  // tag and `'siu-x'` as its class are DOM vocabulary, and the guard is
  // deliberately silent about them. Pinned so the invariant is not "fixed" by
  // making the position axis report DOM vocabulary — which would fire on every
  // `el()` call in the module.
  const exemptBody = `function probe() { return el('span', 'siu-x', 'Save'); }`;
  const exempt = scanRegion(exemptBody, { label: 'exempt vocabulary', names: ['probe'] });
  check(
    'self-test: a declined literal outside every display sink is exempt from both axes',
    exempt.displayPosition.length === 0 &&
      !exempt.unlocalized.some((hit) => hit.includes('"span"') || hit.includes('"siu-x"')) &&
      exempt.unlocalized.some((hit) => hit.includes('"Save"')),
    `copy=${exempt.unlocalized.join(' | ') || 'none'} display=${exempt.displayPosition.join(' | ') || 'none'}`
  );

  // And the detectors must not fire on the benign categories the composer
  // region legitimately contains: ids, classes, attributes, paths, field
  // names, level tokens and separators are not copy.
  const benign = scanRegion(
    `function modelRow(model) {
      row.setAttribute('aria-selected', 'true');
      el('div', 'siu-popover-row');
      postJson('/api/settings', { activeProviderId: 'x', reasoningEffortEffective: 'off' });
      return ' · ' + '—' + '[]' + '%';
    }`,
    { label: 'benign tokens', names: ['modelRow'] }
  );
  check(
    'self-test: benign composer tokens are not reported as copy',
    benign.cjk.length === 0 && benign.unlocalized.length === 0 && benign.displayPosition.length === 0,
    `cjk=${benign.cjk.length} copy=${benign.unlocalized.length} display=${benign.displayPosition.length}`
  );

  // --- calibration: the display-position predicate ---------------------------
  //
  // The positional check is the intersection of two predicates, so both of its
  // halves need pinning. Each case below is a real shape from this module: the
  // enum stored on `dataset`, the same enum rendered, a comparison operand, a
  // markup fragment, and a class token passed as `el()`'s third argument.
  const positionalCases = [
    { source: "chip.dataset.level = level || 'none';", expect: [], why: 'enum stored on a dataset attribute' },
    { source: "row.setAttribute('aria-selected', 'off');", expect: [], why: 'non-display setAttribute value' },
    { source: "return typeof event.result === 'string' ? 'x' : 'y';", expect: [], why: 'typeof comparison operand' },
    { source: "target.innerHTML = CLOCK + '<span>' + n + '</span>';", expect: [], why: 'markup fragment' },
    { source: "row.appendChild(el('span', 'siu-label', 'low'));", expect: ['"low"'], why: 'enum rendered as el() text' },
    { source: "$('x').textContent = payload.sessionId || 'none';", expect: ['"none"'], why: 'enum as an assignment fallback' },
    { source: "toast('off', 'error');", expect: ['"off"'], why: 'literal as a toast message' },
    { source: "badge.title = prefix +\n (branch || 'n/a');", expect: ['"n/a"'], why: 'literal joined across a multi-line statement' }
  ];
  for (const testCase of positionalCases) {
    const hit = scanRegion(`function probe() { ${testCase.source} }`, { label: 'positional calibration', names: ['probe'] });
    const got = hit.displayPosition.map((entry) => entry.slice(0, entry.indexOf(' (')));
    // Exact match, not a subset: a subset assertion would pass even if the
    // check ALSO reported a token it should ignore, which is the failure mode
    // the negative cases exist to pin.
    const ok = got.length === testCase.expect.length && testCase.expect.every((value) => got.includes(value));
    check(
      `self-test: display-position check ${testCase.expect.length ? 'reports' : 'ignores'} ${testCase.why}`,
      ok,
      got.join(' | ') || 'no hit'
    );
  }

  // --- calibration: the predicate's two corpora ------------------------------
  //
  // `looksLikeCopy()` was rebuilt to catch single-token copy, and the risk of
  // that change is over-reach: a predicate that flags `'siu-popover-row'` or
  // `'low'` makes the guard unusable and invites someone to loosen it. Both
  // directions are pinned here, so the calibration is a regression-tested
  // invariant rather than a one-time tune.
  //
  // The copy corpus is the measured miss list: every string the previous
  // whitespace-AND-3-letters predicate returned false for. The non-copy corpus
  // is drawn from the module's real non-copy categories.
  const COPY_CORPUS = [
    '(root)',
    'OS: ',
    'OK',
    'Error',
    'Done',
    'Copy',
    'Save',
    'Cancel',
    'retry',
    'thinking…',
    'Send',
    'No sessions',
    'state: ',
    'leaf: ',
    'main model: ',
    '(autoReview off)',
    '(none sent)'
  ];
  const NON_COPY_CORPUS = [
    '%',
    '—',
    '● ',
    '·',
    ' · ',
    '→ ',
    '[]',
    '* ',
    '› ',
    'status.card.root',
    'composer.effort.high',
    'siu-popover-row',
    'siu-label p-3 text-muted',
    'aria-selected',
    'data-role',
    'role',
    'href',
    'type',
    'tabindex',
    'div',
    'pre',
    'span',
    'button',
    'option',
    'li',
    '/api/settings',
    'low',
    'medium',
    'high',
    'off',
    'danger',
    'warn',
    'ok',
    'main',
    'review',
    'custom',
    'unset',
    'activeProviderId',
    'reasoningEffortEffective',
    'data:',
    '&amp;',
    '⌘N',
    // ARIA role tokens. A role is DOM vocabulary wherever it is written, so
    // `setAttribute('role', 'presentation')` must be declined by value — the
    // workaround that hoisted it out of the guarded regions is what this pins
    // against returning. The full closed set is pinned by its own check below.
    // `option` appears twice (as an HTML tag above and as a role here): it
    // genuinely belongs to both sets, and the duplicate is load-bearing because
    // the self-test's token count is reported from this array, so deduplicating
    // it would change a PASS line for no coverage gain.
    'presentation',
    'listbox',
    'option',
    'dialog',
    'a',
    '7',
    ''
  ];

  const missedCopy = COPY_CORPUS.filter((value) => !looksLikeCopy(value));
  check(
    'self-test: the copy corpus is all detected as copy',
    missedCopy.length === 0,
    missedCopy.length ? `missed ${missedCopy.map((v) => JSON.stringify(v)).join(', ')}` : `${COPY_CORPUS.length} strings`
  );

  const falsePositives = NON_COPY_CORPUS.filter((value) => looksLikeCopy(value));
  check(
    'self-test: the non-copy corpus is all ignored',
    falsePositives.length === 0,
    falsePositives.length ? `flagged ${falsePositives.map((v) => JSON.stringify(v)).join(', ')}` : `${NON_COPY_CORPUS.length} tokens`
  );

  // --- calibration: the ARIA role vocabulary ---------------------------------
  //
  // `setAttribute('role', 'presentation')` is DOM vocabulary, not copy, and the
  // guard reported it as hardcoded English until the closed role set was named.
  // The corpus above lists four role names: `presentation` and `option` are the
  // ones this module writes via `setAttribute('role', …)`, while `listbox` and
  // `dialog` exist only in the markup. (The module's third role write,
  // `button`, is covered by the corpus as an HTML tag token instead.) This
  // check pins the whole set, so a partial or truncated `ARIA_ROLE_NAMES` fails
  // here instead of waiting for someone to write the missing role inside a
  // guarded region and hit the false positive again.
  const flaggedRoles = [...ARIA_ROLE_NAMES].filter((role) => looksLikeCopy(role));
  check(
    'self-test: every ARIA role token is declined by the value predicate',
    ARIA_ROLE_NAMES.size > 70 && flaggedRoles.length === 0,
    flaggedRoles.length ? `flagged ${flaggedRoles.join(', ')}` : `${ARIA_ROLE_NAMES.size} roles`
  );

  // The shape that motivated the change, through the full pipeline: a role
  // written inline in a guarded region must produce NO finding. `role` is not a
  // display sink, so this is where a role legitimately lives.
  const roleSite = scanRegion(
    `function probe() { const head = el('div', 'siu-popover-group-head'); head.setAttribute('role', 'presentation'); return head; }`,
    { label: 'aria role calibration', names: ['probe'] }
  );
  check(
    'self-test: an inline role in a guarded region produces no finding',
    roleSite.unlocalized.length === 0 && roleSite.displayPosition.length === 0,
    `copy=${roleSite.unlocalized.length} display=${roleSite.displayPosition.length}`
  );

  // The boundary is deliberate, not an oversight: the positional check reports a
  // literal the VALUE predicate declines, so a role name RENDERED AS TEXT is
  // still caught. Declining role tokens by value must not exempt English text
  // that happens to spell a role — that would be a real leak, not DOM
  // vocabulary. Pinned so nobody "fixes" it by adding roles to the sink
  // exemptions.
  const roleAsText = scanRegion(
    `function probe() { return el('div', 'siu-x', 'presentation'); }`,
    { label: 'aria role calibration', names: ['probe'] }
  );
  check(
    'self-test: a role name rendered as visible text is still reported',
    roleAsText.displayPosition.some((hit) => hit.includes('"presentation"')),
    roleAsText.displayPosition.join(' | ') || 'no hit'
  );

  // --- static markup scanner -------------------------------------------------

  const cleanMarkup = staticTextNodes('<html><body><span data-i18n="a.b">文字</span><p>plain</p></body></html>');
  check(
    'self-test: the static markup scanner reads annotated and unannotated text',
    cleanMarkup.length === 2 && I18N_ATTRIBUTE.test(cleanMarkup[0].parent.attrs) && !I18N_ATTRIBUTE.test(cleanMarkup[1].parent.attrs),
    `${cleanMarkup.length} nodes`
  );

  // The module's tag-like strings must not be parsed as markup, or the scan
  // reports phantom elements from JS source.
  const withModule = staticTextNodes('<body><script type="module">const x = \'<select>\' + \'<li>plain text</li>\';</script><span data-i18n="a.b">ok</span></body>');
  check(
    'self-test: the static markup scanner ignores script content',
    withModule.length === 1 && withModule[0].text === 'ok',
    withModule.map((n) => JSON.stringify(n.text)).join(', ') || 'no nodes'
  );

  const newLeak = staticTextNodes('<body><span id="fresh-leak">通知</span></body>').filter(
    (node) => !STATIC_TEXT_ALLOWLIST.some((entry) => (entry.id && entry.id === attributeOf(node.parent.attrs, 'id')) || (!entry.id && entry.text === node.text))
  );
  check(
    'self-test: a new unannotated static text element is reported',
    newLeak.length === 1 && newLeak[0].text === '通知',
    newLeak.map((n) => JSON.stringify(n.text)).join(', ') || 'no hit'
  );

  // --- static attribute scanner ----------------------------------------------
  //
  // The exact gap: a copy-bearing attribute is invisible to the text-node scan
  // because the element has no text node at all. Planting `placeholder="Search
  // every model"` must be reported, and the same string as a text node is
  // already covered by the check above.
  const plantedAttribute = staticCopyAttributes('<body><input id="fresh-ph" placeholder="Search every model" /></body>');
  check(
    'self-test: a copy-bearing attribute without data-i18n-* is reported',
    plantedAttribute.findings.length === 1 &&
      plantedAttribute.findings[0].attr === 'placeholder' &&
      plantedAttribute.findings[0].value === 'Search every model',
    plantedAttribute.findings.map((f) => `${f.attr}=${JSON.stringify(f.value)}`).join(', ') || 'no hit'
  );

  // ...and the matching annotation silences it, or the check would be
  // unsatisfiable rather than merely strict.
  const annotatedAttribute = staticCopyAttributes('<body><input id="fresh-ph" placeholder="Search every model" data-i18n-placeholder="a.b" /></body>');
  check(
    'self-test: an annotated copy-bearing attribute is ignored',
    annotatedAttribute.findings.length === 0 && annotatedAttribute.annotatedCount === 1,
    annotatedAttribute.findings.map((f) => `${f.attr}=${JSON.stringify(f.value)}`).join(', ') || 'silent'
  );

  // A non-copy attribute value (a class-like token, an id) must not be
  // reported, or every `title="x-y-z"` selector would fire.
  const benignAttribute = staticCopyAttributes('<body><select id="s" title="current-session" data-i18n-title="a.b"></select><input id="u" placeholder="off" /></body>');
  check(
    'self-test: a non-copy attribute value is not reported',
    benignAttribute.findings.length === 0 && benignAttribute.copyCount === 0,
    benignAttribute.findings.map((f) => `${f.attr}=${JSON.stringify(f.value)}`).join(', ') || `silent (copy=${benignAttribute.copyCount})`
  );

  // --- the annotation regex is exact -----------------------------------------
  //
  // `\b` matches between `i18n` and `-`, so `/data-i18n\b/` accepted
  // `data-i18n-title` as if it were `data-i18n`. An element carrying ONLY a
  // title annotation must not silence the check on its own text node.
  const titleOnly = staticTextNodes('<body><span data-i18n-title="a.b">通知</span></body>');
  check(
    'self-test: a data-i18n-title annotation does not count as data-i18n',
    titleOnly.length === 1 && !I18N_ATTRIBUTE.test(titleOnly[0].parent.attrs),
    `${titleOnly.length} nodes, annotated=${titleOnly.filter((n) => I18N_ATTRIBUTE.test(n.parent.attrs)).length}`
  );
  check(
    'self-test: the exact data-i18n attribute is still recognized',
    I18N_ATTRIBUTE.test(' data-i18n="a.b"') && I18N_ATTRIBUTE.test('data-i18n=a.b') && I18N_ATTRIBUTE.test(' data-i18n>'),
    'whitespace/equals/tag-end forms'
  );

  // --- notifications.js: the same pipeline, the reduced axis set -------------
  //
  // Each new check gets a synthetic body through the SAME `scanModule` the real
  // check uses, so a check that stopped being load-bearing fails here rather
  // than passing silently over the real file. The floor assertion doubles as the
  // proof that extraction reached the code: without it, a `scanModule` that
  // returned no literals would make all three defect checks green at once.

  const notifyClean = scanModule('function probe() { return 1; }');
  check(
    'self-test: the notifications module scan is clean on a clean body',
    notifyClean.cjk.length === 0 && notifyClean.displayPosition.length === 0,
    `cjk=${notifyClean.cjk.length} display=${notifyClean.displayPosition.length}`
  );

  const notifyCjkDefect = scanModule("function probe() { return '通知不可用'; }");
  check(
    'self-test: a hardcoded CJK literal is detectable in the notifications module',
    notifyCjkDefect.cjk.length > 0,
    notifyCjkDefect.cjk.join(' | ') || 'no hit'
  );

  // The sink has to be one this file actually uses. `notifications.js` builds
  // its DOM with `document.createElement` + `textContent` and has no `el()`
  // helper, so an `el()` plant would prove the detector works on a sink the
  // file does not have. The token is one `looksLikeCopy()` DECLINES (`'none'`,
  // as in the region tests) — an accepted literal belongs to the value axis,
  // which is deliberately not applied here, so planting one would produce a
  // green position check and test nothing.
  const notifyDisplayDefect = scanModule(
    "function probe() { const node = document.createElement('div'); node.textContent = level || 'none'; return node; }"
  );
  check(
    'self-test: a literal in a display position is detectable in the notifications module',
    notifyDisplayDefect.displayPosition.some((hit) => hit.includes('"none"')),
    notifyDisplayDefect.displayPosition.join(' | ') || 'no hit'
  );

  // The key-parity check is the one with no region equivalent, so it needs its
  // own plane: a synthetic module body declaring an undefined key must fail the
  // exact predicate the real check runs — `unresolvedTrKeys()` itself, never a
  // re-implementation, or this test would stay green while the real predicate
  // went blind. Both halves are asserted, or the check could pass by seeing no
  // keys at all — the vacuous-pass failure the floors above exist to prevent.
  const undefinedKeyPlan = scanModule("function probe() { return tr('notify.doesNotExist'); }");
  check(
    'self-test: an undefined tr() key in the notifications module is reported',
    unresolvedTrKeys(undefinedKeyPlan.code).includes('notify.doesNotExist') && !zhKeys.has('notify.doesNotExist'),
    unresolvedTrKeys(undefinedKeyPlan.code).join(', ') || 'no hit'
  );
  check(
    'self-test: the notifications module references tr() keys and every one resolves',
    notifyReferenced.length >= 7 && notifyUnresolved.length === 0,
    `${notifyReferenced.length} keys checked, unresolved=${notifyUnresolved.length}`
  );

  // Negative control: the literals the value axis was abandoned for must not
  // trip either of the two axes this file DOES get, or the reduced set would be
  // as unusable as the full one. Both are real shapes from the file — the font
  // stack in the toast stylesheet and the Web Animations easing — and both are
  // ACCEPTED by `looksLikeCopy()`, which is the point: the value axis would have
  // reported them, and the two axes that remain must not.
  //
  // The `literalCount` half is load-bearing, not decoration. This body's
  // ACCEPTED literals (`'SF Pro Text'`, the font names, the easing) are ones the
  // position axis skips by construction — it reports only DECLINED literals — so
  // `displayPosition.length === 0` would hold even over an empty body, and the
  // check would pass without examining anything. `'div'` and `'aria-label'` are
  // the declined literals that make this body non-trivial, and the count
  // assertion proves the scan actually read it. Verified by mutation: removing
  // the position axis's predicate gate adds `"dismiss"` here and fails this
  // check, so it is wired to a live code path rather than passing vacuously.
  const notifyBenign = scanModule(
    "function probe() { const node = document.createElement('div'); close.setAttribute('aria-label', 'dismiss'); return 'SF Pro Text' + 'Helvetica Neue' + 'cubic-bezier(0.22, 1, 0.36, 1)'; }"
  );
  check(
    'self-test: the font stack and cubic-bezier do not trip the notifications module axes',
    looksLikeCopy('SF Pro Text') &&
      looksLikeCopy('cubic-bezier(0.22, 1, 0.36, 1)') &&
      notifyBenign.literalCount >= 6 &&
      notifyBenign.cjk.length === 0 &&
      notifyBenign.displayPosition.length === 0,
    `cjk=${notifyBenign.cjk.length} display=${notifyBenign.displayPosition.join(' | ') || 'none'}`
  );

  // The floors are the vacuous-pass guard for the whole-file read, so their
  // relationship to the real measurement is pinned here: if the file shrank
  // below a floor (or the read/extract silently returned a stub), the real
  // checks would go green over nothing. Asserted against the actual file rather
  // than a constant, so the numbers cannot drift apart from what they measure.
  check(
    'self-test: the notifications module floors are below the real measurement',
    notifications.lines > NOTIFICATIONS_MIN_LINES && notifications.literalCount > NOTIFICATIONS_MIN_LITERALS,
    `measured ${notifications.lines} lines / ${notifications.literalCount} literals against floors ${NOTIFICATIONS_MIN_LINES} / ${NOTIFICATIONS_MIN_LITERALS}`
  );

  // --- whole-file key resolution: both directions, plus the exclusion -------
  //
  // Each case runs through the SAME `trKeySites` / `i18nValueSites` /
  // `unresolvedSites` the real checks call, never a re-implementation, so a
  // predicate that stopped resolving keys fails here instead of passing over
  // the real files. Every case asserts the extracted set is non-empty as well
  // as its resolution: a scanner that found no keys at all would make the
  // "resolves" half trivially true.

  const plantedTr = trKeySites("function probe() { return tr('palette.quitZZZ'); }");
  check(
    'self-test: an undefined tr() literal outside every region is reported',
    plantedTr.sites.length === 1 &&
      plantedTr.sites[0].key === 'palette.quitZZZ' &&
      unresolvedSites(plantedTr.sites).length === 1 &&
      !zhKeys.has('palette.quitZZZ'),
    unresolvedSites(plantedTr.sites).map((s) => s.key).join(', ') || 'no hit'
  );

  const definedTr = trKeySites("function probe() { return tr('palette.quit'); }");
  check(
    'self-test: a defined tr() literal is not reported',
    definedTr.sites.length === 1 && unresolvedSites(definedTr.sites).length === 0,
    definedTr.sites.map((s) => s.key).join(', ') || 'no hit'
  );

  const plantedValue = i18nValueSites('<body><label data-i18n="settings.themeZZZ">文字</label></body>');
  check(
    'self-test: an undefined data-i18n value is reported',
    plantedValue.length === 1 &&
      plantedValue[0].key === 'settings.themeZZZ' &&
      plantedValue[0].attr === 'data-i18n' &&
      unresolvedSites(plantedValue).length === 1 &&
      !enKeys.has('settings.themeZZZ'),
    unresolvedSites(plantedValue).map((s) => s.key).join(', ') || 'no hit'
  );

  const definedValue = i18nValueSites('<body><label data-i18n="settings.theme">文字</label></body>');
  check(
    'self-test: a defined data-i18n value is not reported',
    definedValue.length === 1 && unresolvedSites(definedValue).length === 0,
    definedValue.map((s) => s.key).join(', ') || 'no hit'
  );

  // The exclusion must be narrow enough that a real key still fails, and it
  // must actually be applied — a filter that silently swallowed every literal
  // would make both checks above pass over nothing. The same body carries one
  // dynamic prefix and one undefined real key, and the split is asserted: the
  // prefix is excluded, the key is not.
  const mixed = trKeySites("function probe() { return tr('badge.' + status) + tr('palette.quitZZZ'); }");
  check(
    'self-test: a trailing-dot dynamic prefix is excluded while a real key still fails',
    mixed.excluded.length === 1 &&
      mixed.excluded[0].key === 'badge.' &&
      mixed.excluded[0].why === 'dynamic prefix' &&
      mixed.sites.length === 1 &&
      unresolvedSites(mixed.sites).length === 1,
    `excluded=[${mixed.excluded.map((e) => e.key).join(', ')}] checked=[${mixed.sites.map((s) => s.key).join(', ')}]`
  );

  // The other two exclusion classes, pinned for the same reason: a
  // template-carrying literal and a non-key-shaped one are excluded, while the
  // real key beside them is still resolved.
  const shaped = trKeySites("function probe() { return tr('a.{n}') + tr('no-dots-here') + tr('status.card.root'); }");
  check(
    'self-test: template and non-key-shaped tr() literals are excluded, the key is not',
    shaped.excluded.length === 2 &&
      shaped.excluded.every((e) => e.why === 'template placeholder' || e.why === 'not key-shaped') &&
      shaped.sites.length === 1 &&
      shaped.sites[0].key === 'status.card.root' &&
      unresolvedSites(shaped.sites).length === 0,
    `excluded=[${shaped.excluded.map((e) => `${e.key}:${e.why}`).join(', ')}] checked=[${shaped.sites.map((s) => s.key).join(', ')}]`
  );

  // The annotation scan must read every one of the four attributes, or a
  // missing key on three of them stays invisible.
  const everyAttribute = I18N_VALUE_ATTRIBUTES.map((name) => ({
    name,
    sites: i18nValueSites(`<body><span ${name}="settings.themeZZZ"></span></body>`)
  }));
  check(
    'self-test: all four data-i18n* attributes are scanned',
    everyAttribute.every(({ name, sites }) => sites.length === 1 && sites[0].key === 'settings.themeZZZ' && sites[0].attr === name),
    everyAttribute.map(({ name, sites }) => `${name}=${sites.length}`).join(' ')
  );

  // And the scan reads only the markup: a `data-i18n` mentioned inside the
  // module's JS (as a selector string or a `dataset` name) must not be
  // mistaken for an annotation, or every `delete node.dataset.i18nAriaLabel`
  // would be reported as a missing key.
  const scriptMention = i18nValueSites('<body><script type="module">const q = \'[data-i18n="settings.themeZZZ"]\';</script><span data-i18n="settings.theme">x</span></body>');
  check(
    'self-test: a data-i18n mention inside the module script is not scanned',
    scriptMention.length === 1 && scriptMention[0].key === 'settings.theme',
    scriptMention.map((s) => s.key).join(', ') || 'no hit'
  );

  // --- dynamic-prefix families ---------------------------------------------
  //
  // Each case runs through the SAME `expandFamily` / `producerValues` the real
  // checks call, against synthetic producers and synthetic tables, so the
  // resolver, the not-found failure and the floor are all exercised rather
  // than trusted. A case that asserted on a re-implementation would let the
  // real code rot while the copy stayed green.

  const SYNTH_FAMILY = { prefix: 'badge.', producer: 'const known = ', guard: 'known.includes(status)', minValues: 2, where: 'synthetic' };

  // The positive half: a value set whose every expansion resolves must produce
  // no unresolved key AND no extraction problem, or the check would be a
  // permanent false alarm.
  const allResolve = expandFamily(
    "const known = ['running', 'done'];",
    SYNTH_FAMILY,
    new Set(['badge.running', 'badge.done']),
    new Set(['badge.running', 'badge.done'])
  );
  check(
    'self-test: a fully-resolving producing list is reported clean',
    allResolve.values.length === 2 && allResolve.unresolved.length === 0 && allResolve.problems.length === 0,
    `values=[${allResolve.values.join(', ')}] unresolved=${allResolve.unresolved.length} problems=${allResolve.problems.join('; ') || 'none'}`
  );

  // The defect half: the same shape with one expansion missing from ONE table.
  // The extraction must still succeed (so the failure is attributable to the
  // dictionary, not the parser) and must name exactly the missing key.
  const oneMissing = expandFamily(
    "const known = ['running', 'done'];",
    SYNTH_FAMILY,
    new Set(['badge.running', 'badge.done']),
    new Set(['badge.running'])
  );
  check(
    'self-test: an expansion missing from one table is reported and named',
    oneMissing.problems.length === 0 &&
      oneMissing.values.length === 2 &&
      oneMissing.unresolved.length === 1 &&
      oneMissing.unresolved[0].key === 'badge.done',
    `unresolved=[${oneMissing.unresolved.map((s) => s.key).join(', ')}] problems=${oneMissing.problems.join('; ') || 'none'}`
  );

  // The loud-failure rule: a producer that cannot be found is NOT an empty
  // value set that passes quietly. Without this, a rename of `STATUS_IDS`
  // would drop the family to zero keys and every check would stay green.
  const notFound = expandFamily("const renamedElsewhere = ['running'];", SYNTH_FAMILY, new Set(), new Set());
  check(
    'self-test: a producer that cannot be found fails loudly',
    notFound.values.length === 0 && notFound.problems.length > 0 && /not found/.test(notFound.problems[0]),
    notFound.problems.join('; ') || 'no problem reported'
  );

  // The floor: a producer that IS found but declares nothing is a distinct
  // failure from a missing producer, and it must not pass as a clean empty
  // family either.
  const emptyList = expandFamily('const known = [];', SYNTH_FAMILY, new Set(), new Set());
  check(
    'self-test: a producing list that yields 0 values fails',
    emptyList.values.length === 0 && emptyList.problems.some((p) => /0 values/.test(p)),
    emptyList.problems.join('; ') || 'no problem reported'
  );

  // And the floor is a floor, not a presence test: a producer that shrank
  // below its recorded size is reported too.
  const tooFew = expandFamily("const known = ['running'];", SYNTH_FAMILY, new Set(['badge.running']), new Set(['badge.running']));
  check(
    'self-test: a producing list below its floor is reported',
    tooFew.values.length === 1 && tooFew.problems.some((p) => /floor/.test(p)),
    tooFew.problems.join('; ') || 'no problem reported'
  );

  // `producerValues` must not silently accept a `[` that belongs to a LATER
  // statement — otherwise a refactor that deleted the array would still find
  // some unrelated one and report a false clean.
  check(
    'self-test: a producer with no array on its own line is not resolved',
    producerValues('const known = compute();\nconst other = [1, 2];', 'const known = ') === null,
    JSON.stringify(producerValues('const known = compute();\nconst other = [1, 2];', 'const known = '))
  );

  // The coverage assertion must reject an excluded prefix no family expands.
  // Exercised through the same helper the real check calls, so a future edit
  // that makes the real check permissive fails here.
  check(
    'self-test: an excluded prefix no family expands is reported as uncovered',
    uncoveredDynamicPrefixes(['badge.', 'theme.'], new Set(['badge.'])).join(',') === 'theme.' &&
      uncoveredDynamicPrefixes(['badge.'], new Set(['badge.'])).length === 0,
    `uncovered=[${uncoveredDynamicPrefixes(['badge.', 'theme.'], new Set(['badge.'])).join(', ')}]`
  );

  // A family whose producer yields values below its floor must not count as
  // covering its prefix — otherwise a truncated list would still be advertised
  // as covered.
  const shrunk = expandFamily("const known = ['running'];", SYNTH_FAMILY, new Set(['badge.running']), new Set(['badge.running']));
  check(
    'self-test: a family that failed its floor does not count as covering its prefix',
    shrunk.problems.length > 0 && shrunk.problems.some((p) => /floor/.test(p)),
    shrunk.problems.join('; ') || 'no problem reported'
  );

  // The three real families must actually be found in the real module body,
  // with the value counts this check was calibrated on. Asserted against the
  // live extraction, so the floors cannot drift apart from what they measure.
  const realCounts = DYNAMIC_KEY_FAMILIES.map((family) => ({ family, values: producerValues(moduleBody, family.producer) ?? [] }));
  check(
    'self-test: all three real dynamic families are extracted from the module',
    realCounts.every(({ family, values }) => values.length >= family.minValues),
    realCounts.map(({ family, values }) => `${family.prefix}${values.length}`).join(' ')
  );
  check(
    'self-test: every real dynamic family expansion resolves in both tables',
    realCounts.every(({ family, values }) => values.every((v) => zhKeys.has(family.prefix + v) && enKeys.has(family.prefix + v))),
    realCounts.map(({ family, values }) => `${family.prefix}${values.length}/${values.length}`).join(' ')
  );
}

console.log(failures === 0 ? '\nUI localization guard passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
