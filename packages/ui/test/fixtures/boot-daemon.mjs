/**
 * Boot `packages/ui/src/daemon.ts` as if it were the `superiu-server` binary.
 *
 * The idle-update persistence tests drive the REAL `main()`/`commandStart`, not
 * a seam. Two things stand between a test and that: the module is TypeScript,
 * and `commandStart` only starts the loop when
 * `path.basename(process.execPath) === 'superiu-server'`. So the test hard-links
 * the running node binary to `<workspace>/superiu-server` and runs THIS shim
 * through it.
 *
 * The shim does the two things node does not:
 *
 *   1. rewrites `argv` so the module's standalone guard fires with the command
 *      line the test asked for (`import.meta.url === pathToFileURL(argv[1])`),
 *      and
 *   2. resolves the sources' `./x.js` specifiers to `./x.ts` — node strips the
 *      types (with `--experimental-strip-types`) but does not remap extensions,
 *      so `daemon.ts`'s `import ... from './server.js'` would otherwise fail.
 *
 * Usage: `superiu-server --experimental-strip-types boot-daemon.mjs <daemon.ts> <command> [options]`
 */
import { pathToFileURL } from 'node:url';

// `registerHooks` landed in node 22.15. Feature-detect it so an older runtime
// reports a clear reason instead of crashing on the import — the test suite
// skips this fixture entirely when the runtime cannot run it.
const { registerHooks } = await import('node:module');
if (typeof registerHooks !== 'function') {
  process.stderr.write('boot-daemon: this node lacks module.registerHooks (needs node >= 22.15)\n');
  process.exit(2);
}

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      // Only the TypeScript sources use extensionless-at-runtime `./x.js`
      // specifiers; retry those as `.ts` before giving up on the original error.
      if (specifier.endsWith('.js')) {
        try {
          return next(`${specifier.slice(0, -3)}.ts`, context);
        } catch {
          // Fall through to the original resolution failure below.
        }
      }
      throw err;
    }
  }
});

const [entry, ...rest] = process.argv.slice(2);
if (!entry) {
  process.stderr.write('boot-daemon: missing entry module\n');
  process.exit(2);
}

process.argv = [process.execPath, entry, ...rest];
await import(pathToFileURL(entry).href);
