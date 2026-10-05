#!/usr/bin/env node
/**
 * Extracts a version's bilingual section from CHANGELOG.md as the GitHub
 * Release body, and validates changelog structure.
 *
 * 从 CHANGELOG.md 提取指定版本的中英双语小节作为 GitHub Release 正文，
 * 并校验 changelog 结构。
 *
 * Usage / 用法:
 *   node scripts/extract-changelog.mjs --version=0.2.7   # tagged release / 标签发布
 *   node scripts/extract-changelog.mjs --unreleased      # rolling `latest` / 滚动渠道
 *   node scripts/extract-changelog.mjs --check           # validate structure / 结构校验
 *   node scripts/extract-changelog.mjs --check --file=path/to/CHANGELOG.md
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ZH = "### 中文";
const EN = "### English";

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function fail(msg) {
  console.error(`[changelog] ${msg}`);
  process.exit(1);
}

const changelogPath =
  value("file") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md");

let text;
try {
  text = readFileSync(changelogPath, "utf8");
} catch {
  fail(`Cannot read ${changelogPath} / 无法读取 ${changelogPath}`);
}

/** Split markdown into `## ` sections; drops the title/intro above the first one. */
function parseSections(md) {
  const sections = [];
  let current = null;
  for (const line of md.split(/\r?\n/)) {
    const match = /^## (.*)$/.exec(line);
    if (match) {
      current = { heading: match[1].trim(), body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  return sections;
}

const sections = parseSections(text);

function assertBilingual(section, label) {
  const body = section.body.join("\n");
  if (!body.includes(ZH) || !body.includes(EN)) {
    fail(
      `Section "${label}" must contain both "${ZH}" and "${EN}". ` +
        `Releases require a bilingual changelog. / 小节 "${label}" 必须同时包含 "${ZH}" 与 "${EN}"，发布说明必须中英双语。`,
    );
  }
}

function findVersion(version) {
  const normalized = version.replace(/^v/, "");
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return sections.find((s) => new RegExp(`^v?${escaped}(\\s|\\(|$)`).test(s.heading));
}

if (has("check")) {
  const errors = [];
  if (!sections.some((s) => /^Unreleased(\s|\||$)/.test(s.heading))) {
    errors.push("Missing `## Unreleased` section / 缺少 `## Unreleased` 小节");
  }
  if (!sections.some((s) => /^v?\d+\.\d+\.\d+(\s|\(|$)/.test(s.heading))) {
    errors.push("No versioned sections found / 未找到任何版本小节");
  }
  for (const s of sections) {
    const isUnreleased = /^Unreleased(\s|\||$)/.test(s.heading);
    const isVersioned = /^v?\d+\.\d+\.\d+(\s|\(|$)/.test(s.heading);
    if (!isUnreleased && !isVersioned) {
      errors.push(`Unexpected heading format: "${s.heading}" / 小节标题格式错误`);
    }
    if (!s.body.join("\n").includes(ZH) || !s.body.join("\n").includes(EN)) {
      errors.push(`Section "${s.heading}" is not bilingual / 小节 "${s.heading}" 非中英双语`);
    }
  }
  if (errors.length > 0) {
    fail(`CHANGELOG.md check failed / 校验未通过:\n  - ${errors.join("\n  - ")}`);
  }
  console.log(`[changelog] OK: ${sections.length} bilingual sections / ${sections.length} 个双语小节`);
  process.exit(0);
}

const version = value("version");
if (!version && !has("unreleased")) {
  fail("Usage: --version=<x.y.z> | --unreleased | --check / 请指定版本、未发布小节或校验模式");
}

const section = has("unreleased")
  ? sections.find((s) => /^Unreleased(\s|\||$)/.test(s.heading))
  : findVersion(version);

if (!section) {
  const label = has("unreleased") ? "Unreleased" : `v${version.replace(/^v/, "")}`;
  fail(
    `No changelog section for ${label}. Add it to CHANGELOG.md before releasing. / ` +
      `CHANGELOG.md 中没有 ${label} 的小节，发布前必须先补充中英双语 changelog。`,
  );
}

assertBilingual(section, section.heading);
process.stdout.write(`${section.body.join("\n").trim()}\n`);
