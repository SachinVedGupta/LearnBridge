import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createD2lBrowser } from '../../apps/local-runtime/src/d2l-browser.mjs';

const fixturePath = fileURLToPath(new URL('./d2l-browser-fixture.mjs', import.meta.url));
/** Actual child + shipped browser expression, with invented school responses.
 * No live service, browser, account, credential or provider is contacted.
 */
export function syntheticSchool(controlPath, mode = 'normal') {
  writeFileSync(controlPath, '{}', { mode: 0o600 });
  const launches = [], reads = [], commands = []; let waiting = [];
  const notify = () => { for (const item of [...waiting]) if (item.match(item.values)) { waiting = waiting.filter(value => value !== item); clearTimeout(item.timer); item.resolve(); } };
  function wait(values, match) { if (match(values)) return Promise.resolve(); return new Promise((resolve, reject) => {
    const item = { values, match, resolve, timer: setTimeout(() => { waiting = waiting.filter(value => value !== item); reject(new Error('Expected synthetic school operation was not reached')); }, 3000) }; waiting.push(item);
  }); }
  return { launches, reads, commands,
    change(value) { writeFileSync(controlPath, JSON.stringify({ ...JSON.parse(readFileSync(controlPath, 'utf8')), ...value }), { mode: 0o600 }); },
    waitRead: match => wait(reads, match), waitCommand: match => wait(commands, match),
    assertClosed(assert) { for (const value of launches) { assert.equal(existsSync(value.profile), false); assert.equal(value.child.exitCode === null && value.child.signalCode === null, false); } },
    factory() { return createD2lBrowser({ factory(binary, args, config) {
      const child = spawn(process.execPath, [fixturePath, mode, controlPath], config), profile = args.find(value => value.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
      launches.push({ binary, args, config, child, profile }); const write = child.stdio[3].write.bind(child.stdio[3]);
      child.stdio[3].write = data => { const command = JSON.parse(data.slice(0, -1)); commands.push(command);
        if (command.method === 'Runtime.evaluate') { const path = /path = ("[^"\n]+")/.exec(command.params.expression); if (path) reads.push(JSON.parse(path[1])); }
        notify();
        return write(data);
      }; return child;
    } }); },
  };
}
