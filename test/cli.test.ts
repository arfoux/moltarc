// CLI e2e: bin/molt.ts seal -> ship -> find over scratch dirs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { scratch, writeHotLog } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'molt.ts');

function run(...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

describe('cli e2e', () => {
  it('seal, ship, and find one trx through the binary', () => {
    const dir = scratch('cli');
    const { hotDb, ids } = writeHotLog(dir, { rows: 300 });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');

    const sealed = run('seal', hotDb, outDir);
    assert.match(sealed, /sealed 300 rows/);

    const shipped = run('ship', outDir, relayDir);
    assert.match(shipped, /shipped \d+ chunk/);

    const target = ids[150];
    const found = run('find', outDir, target);
    assert.ok(found.includes(target));

    assert.throws(() => run('find', outDir, 'trx-99999999'), /not found/);
    assert.throws(() => run('seal', join(dir, 'missing.jsonl'), outDir));
  });
});
