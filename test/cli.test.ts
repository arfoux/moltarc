// CLI e2e: bin/moltarc.ts seal -> ship -> find over scratch dirs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { scratch, writeHotLog } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'moltarc.ts');

function run(...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000 });
}

describe('cli e2e', () => {
  it('seal, ship, and find one trx through the binary', { timeout: 30_000 }, () => {
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
  it('ship resumes a killed transfer without resending finished chunks', { timeout: 30_000 }, async () => {
    const dir = scratch('cli-resume');
    const { hotDb } = writeHotLog(dir, { rows: 4000, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    const sealed = await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
    assert.ok(sealed.chunks.length >= 3, `need >=3 chunks, got ${sealed.chunks.length}`);

    // Kill the transfer mid-chunk (injected transport death, no retries).
    await assert.rejects(
      ship({ outDir, relayDir, blockBytes: 512, failAtBytes: 1500, maxRetries: 0, baseDelayMs: 1 }),
      /injected transport failure/,
    );
    assert.ok(readdirSync(relayDir).some((f: string) => f.startsWith('.ship-state-')), 'crash leaves a resume journal');

    // CLI completes what is missing.
    const done = run('ship', outDir, relayDir);
    assert.match(done, /shipped \d+ chunk\(s\)/);

    // Second run sends nothing: finished chunks are never resent.
    const again = run('ship', outDir, relayDir);
    assert.match(again, /shipped 0 chunk\(s\)/);

    // Every relay byte matches its sealed chunk.
    for (const c of sealed.chunks) {
      const name = c.split(/[\\/]/).pop() as string;
      assert.ok(readFileSync(join(relayDir, 'chunks', name)).equals(readFileSync(c)));
    }
  });

  it('seal reports replaced rows on same-key overwrite', { timeout: 30_000 }, () => {
    const dir = scratch('cli-replaced');
    const hotDb = join(dir, 'hot.jsonl');
    writeFileSync(hotDb, [
      JSON.stringify({ device_id: 'd1', seq: 1, ts: 1, id: 'a', table: 't', body: 'FIRST' }),
      JSON.stringify({ device_id: 'd1', seq: 1, ts: 2, id: 'a', table: 't', body: 'SECOND' }),
    ].join('\n') + '\n');
    const out = run('seal', hotDb, join(dir, 'archive'));
    assert.match(out, /sealed 1 rows/);
    assert.ok(out.includes('replaced 1 row(s)'), `missing replaced line:\n${out}`);
  });
});
