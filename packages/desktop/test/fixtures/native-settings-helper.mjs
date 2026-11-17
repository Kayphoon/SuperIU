// A wire-level native peer: no Electron, AppKit, clipboard or global hotkeys.
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const directory = dirname(fileURLToPath(import.meta.url));
appendFileSync(join(directory, 'starts.log'), 'start\n');
let configuration = {
  captureShortcut: { keyCode: 19, modifiers: 768 },
  historyShortcut: { keyCode: 9, modifiers: 768 },
  imagePersistenceEnabled: true
};
let historyCount = 3;
const persist = () => writeFileSync(join(directory, 'peer-state.json'), JSON.stringify({ configuration, historyCount }));
let output = Promise.resolve();
function reply(payload) {
  // Preserve line order while exercising fragmented stdout delivery.
  const line = 'SUPERIU_NATIVE_RESPONSE ' + JSON.stringify(payload) + '\n';
  output = output.then(async () => {
    process.stdout.write(line.slice(0, 13));
    await new Promise(setImmediate);
    process.stdout.write(line.slice(13));
  });
}

persist();
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line === 'quit') process.exit(0);
  const request = JSON.parse(line);
  if (fixtureMode === 'exit') process.exit(3);
  if (fixtureMode === 'malformed') {
    reply({ id: request.id, ok: true, settings: { imagePersistenceEnabled: false } });
    return;
  }
  if (request.action === 'configure') {
    if (request.settings.captureShortcut.keyCode === 12) {
      reply({ id: request.id, ok: false, error: 'Shortcut is occupied.' });
      return;
    }
    configuration = request.settings;
  } else if (request.action === 'clearHistory') {
    historyCount = 0;
  } else if (request.action !== 'getSettings') {
    reply({ id: request.id, ok: false, error: 'Unsupported request.' });
    return;
  }
  persist();
  reply({ id: request.id, ok: true, settings: configuration });
});
input.on('close', () => process.exit(0));
process.stdout.write('SUPERIU_NATIVE_READY\n');
