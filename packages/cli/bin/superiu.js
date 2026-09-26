#!/usr/bin/env node
import pc from 'picocolors';
import { resolveLanguage, t } from '../dist/language.js';
import { startCli } from '../dist/index.js';
import { redactSecrets } from '../dist/redact.js';

startCli().catch((err) => {
  // The language is re-resolved here: a failure can happen before startCli's
  // own `language` binding exists.
  const message = err instanceof Error ? err.message : String(err);
  // No runner is in scope on this path — it is a failure of `startCli` itself,
  // so `getModelRoutes()` has no source here. The pattern pass stands alone; see
  // `redactSecrets` for why that is the whole story for this site.
  console.error(pc.red(t(resolveLanguage(), 'cli.fatal', { message: redactSecrets(message) })));
  process.exit(1);
});
