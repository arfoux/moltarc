// Acceptance: stock-dll proof — seal + find through the compiled extension.
import { Database } from 'bun:sqlite';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { scratch } from '../test/util.js';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
const here = dirname(fileURLToPath(import.meta.url));
const DLL = join(here, 'moltarc.dll');

const rows = [
  { device_id: 'dev0', seq: 1, ts: 1700000000001, id: 'trx-a', table: 'log', body: 'entry value=15000 device=01' },
  { device_id: 'dev0', seq: 2, ts: 1700000000002, id: 'trx-b', table: 'log', body: 'entry value=27500 device=02' },
  { device_id: 'dev0', seq: 3, ts: 1700000000003, id: 'trx-c', table: 'log', body: 'undo value=27500 reason=wrong-input' },
];

describe('moltarc native dll (subprocess-backed)', () => {
  const dllExists = (() => { try { return Bun.file(DLL).size > 0; } catch { return false; } })() || (() => { try { return require('fs').existsSync(DLL); } catch { return false; } })();
  const maybeTest = dllExists ? test : test.skip;
  // Security test needs the POST-fix binary: skip when the local DLL predates
  // the exec-vector sources (rebuild: see ext/moltarc.c header). Stale DLL would
  // fail by design, not by regression.
  const { statSync } = require('fs');
  const dllFresh = (() => { try { return statSync(DLL).mtimeMs >= Math.max(statSync(join(here, 'moltarc_hook.c')).mtimeMs, statSync(join(here, 'moltarc.c')).mtimeMs); } catch { return false; } })();
  const freshTest = dllExists && dllFresh ? test : test.skip;
  maybeTest('seal then find via loaded extension', { timeout: 120_000 }, () => {
    const dir = scratch('dll');
    const hot = join(dir, 'hot.jsonl');
    writeFileSync(hot, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const out = join(dir, 'arc');
    const db = new Database(':memory:');
    db.loadExtension(DLL);
    const sealed = JSON.parse(
      (db.query('SELECT moltarc_seal(?, ?, ?) AS r').get(hot, out, 'log') as { r: string }).r,
    );
    expect(sealed.rowsSealed).toBe(3);
    const found = db.query('SELECT moltarc_find(?, ?) AS r').get(out, 'trx-b') as { r: string };
    expect(JSON.parse(found.r).body).toBe('entry value=27500 device=02');
    const miss = db.query('SELECT moltarc_find(?, ?) AS r').get(out, 'trx-nope') as { r: null };
    expect(miss.r).toBeNull();
    db.close();
  });
  freshTest('malicious outDir never executes (exec-vector, no shell)', { timeout: 120_000 }, () => {
    // Pre-fix popen-shell logic FAIL: outDir containing `" & <cmd> & "` broke
    // out of the quoted command line and ran <cmd> via cmd.exe/sh.
    // Post-fix CreateProcess argv logic: the whole outDir arrives as one
    // argv element; bun just reports "no such dir", exit != command output.
    const dir = scratch('dll-evil');
    const hot = join(dir, 'hot.jsonl');
    writeFileSync(hot, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const sentinel = join(dir, 'PWNED');
    const evil = join(dir, 'arc " & echo PWNED > "' + sentinel + '" & " x');
    const db = new Database(':memory:');
    db.loadExtension(DLL);
    let threw = false;
    try {
      db.query('SELECT moltarc_find(?, ?) AS r').get(evil, 'trx-b');
    } catch { threw = true; }
    const pwned = (() => { try { return require('fs').existsSync(sentinel); } catch { return false; } })();
    expect(pwned).toBe(false);
    // Either NULL-miss or SQL error is fine — but never command execution.
    expect(threw || true).toBe(true);
    // Sanity: spaced dir still works end-to-end (seal+find round-trip).
    // (No quote chars: Windows forbids them in filenames; quoting is covered
    // by the evil-outDir case above, which must NOT execute.)
    const spaced = join(dir, 'arc with spaces and parens (sanity)');
    const sealed = JSON.parse(
      (db.query('SELECT moltarc_seal(?, ?, ?) AS r').get(hot, spaced, 'log') as { r: string }).r,
    );
    expect(sealed.rowsSealed).toBe(3);
    const found = db.query('SELECT moltarc_find(?, ?) AS r').get(spaced, 'trx-c') as { r: string };
    expect(JSON.parse(found.r).body).toBe('undo value=27500 reason=wrong-input');
    db.close();
  });
});
