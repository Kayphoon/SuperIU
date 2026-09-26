#!/usr/bin/env node
import pc from 'picocolors';
import { resolveLanguage, t } from '../dist/language.js';
import { startCli } from '../dist/index.js';

startCli().catch((err) => {
  // The language is re-resolved here: a failure can happen before startCli's
  // own `language` binding exists.
  const message = err instanceof Error ? err.message : String(err);
  console.error(pc.red(t(resolveLanguage(), 'cli.fatal', { message })));
  process.exit(1);
});
