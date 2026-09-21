#!/usr/bin/env node
import { startCli } from '../dist/index.js';

startCli().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
