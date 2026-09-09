// hook + timetravel damage-contract regressions.
// (1) ext/moltarc_hook.c must surface bun stderr to the C caller: no
// `(void)err`, stderr captured per call, *err set on every failure path,
// miss (find rc==1 -> return 1, *err NULL) distinguishable from error.
// (2) queryAsOf over a damaged archive: corrupt bytes fail closed (throw,
// naming the chunk), missing files stay loud AND counted (warn names
// proof.skippedMissing, counter > 0, rows partial, assertTimeTravelComplete
// throws). Fixture mirrors test/timetravel.test.ts (encodeChunk directly,
// no seal clock dependence).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { encodeChunk, type HotRow } from '../src/chunk.js';
import { chunkName } from '../src/seal.js';
import { buildManifest, saveManifestAtomic } from '../src/manifest.js';
import { assertTimeTravelComplete, queryAsOf } from '../src/timetravel.js';
import { scratch } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));

function row(id: string, seq: number, ts: number, body: string): HotRow {
  return { device_id: 'dev-01', seq, ts, id, table: 'events', body };
}

function fixedArchive(): { outDir: string; names: string[] } {
  const dir = scratch('hooktime');
  const outDir = join(dir, 'archive');
  const warm = join(outDir, 'warm');
  mkdirSync(warm, { recursive: true });
  const batches: HotRow[][] = [
    [row('a', 1, 1000, 'a-v1'), row('b', 2, 2000, 'b-v1'), row('c', 3, 3000, 'c-v1')],
    [row('b', 4, 4000, 'b-v2'), row('d', 5, 5000, 'd-v1')],
    [row('a', 6, 6000, 'a-v2')],
  ];
  const names = batches.map((rows) => {
    const bytes = encodeChunk('events', rows);
    return chunkName('events', rows[0].seq, rows[rows.length - 1].seq, bytes);
  });
  batches.forEach((rows, i) => writeFileSync(join(warm, names[i]), encodeChunk('events', rows)));
  saveManifestAtomic(outDir, buildManifest(outDir));
  return { outDir, names };
}

const byId = (rows: HotRow[]) => Object.fromEntries(rows.map((r) => [r.id, `${r.seq}:${r.ts}:${r.body}`]));

function captureWarns<T>(fn: () => T): { value: T; warns: string[] } {
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => warns.push(String(a[0]));
  try {
    return { value: fn(), warns };
  } finally {
    console.warn = origWarn;
  }
}

describe('hooktime: timetravel over a damaged archive', () => {
  it('missing chunk is loud + counted, rows partial, helper forces the check', { timeout: 30_000 }, () => {
    const { outDir, names } = fixedArchive();
    rmSync(join(outDir, 'warm', names[1])); // chunk2 carried b-v2 + d-v1
    const { value: r, warns } = captureWarns(() => queryAsOf({ outDir, ts: 6500 }));
    assert.equal(r.proof.skippedMissing, 1);
    assert.ok(!r.proof.chunksConsulted.includes(names[1]));
    assert.ok(
      warns.some((m) => m.includes('missing') && m.includes('must check proof.skippedMissing')),
      `expected loud warn forcing the proof.skippedMissing check, got: ${warns.join('; ')}`,
    );
    // Partial fold: d never seen, b stuck at its stale v1.
    assert.deepEqual(byId(r.rows), { a: '6:6000:a-v2', b: '2:2000:b-v1', c: '3:3000:c-v1' });
    assert.throws(() => assertTimeTravelComplete(r), /skippedMissing/);
  });

  it('healthy archive: skippedMissing 0, helper is a no-op', { timeout: 30_000 }, () => {
    const { outDir } = fixedArchive();
    const { value: r, warns } = captureWarns(() => queryAsOf({ outDir, ts: 6500 }));
    assert.equal(r.proof.skippedMissing, 0);
    assert.ok(!warns.some((m) => m.includes('missing')));
    assert.deepEqual(byId(r.rows), { a: '6:6000:a-v2', b: '4:4000:b-v2', c: '3:3000:c-v1', d: '5:5000:d-v1' });
    assertTimeTravelComplete(r); // must not throw
  });

  it('corrupt chunk fails closed, naming the chunk', { timeout: 30_000 }, () => {
    const { outDir, names } = fixedArchive();
    const victim = join(outDir, 'warm', names[0]);
    const bytes = Buffer.from(readFileSync(victim));
    bytes[bytes.length - 1] ^= 0xff; // break the crc-covered body tail
    writeFileSync(victim, bytes);
    assert.throws(
      () => queryAsOf({ outDir, ts: 6500 }),
      (e: unknown) => {
        const m = e instanceof Error ? e.message : String(e);
        return m.includes('timetravel: corrupt chunk') && m.includes(names[0]) && m.includes('fail-closed');
      },
    );
  });
});

describe('hooktime: moltarc_hook.c surfaces bun stderr', () => {
  const src = readFileSync(join(here, '../ext/moltarc_hook.c'), 'utf8');

  it('never discards the caller err slot', { timeout: 30_000 }, () => {
    assert.ok(!src.includes('(void)err'), 'hook must not void out *err: failures need the bun message');
  });

  it('captures bun stderr out of the stdout pipe', { timeout: 30_000 }, () => {
    assert.ok(src.includes('2>'), 'hook must redirect bun stderr (2>) into a per-call capture, not the JSON pipe');
    assert.ok(
      (src.match(/if \(err\) \*err = 0;/g) ?? []).length >= 2,
      'both find and seal entry points must init *err before running bun',
    );
  });

  it('find miss stays distinguishable from find error', { timeout: 30_000 }, () => {
    const findFn = src.slice(src.indexOf('moltarc_chunk_find'));
    const sealAt = findFn.indexOf('moltarc_chunk_seal');
    const findBody = sealAt >= 0 ? findFn.slice(0, sealAt) : findFn;
    assert.ok(findBody.includes('return 1;'), 'find miss (bun exit 1) must keep its own return code, not -1');
    assert.ok(findBody.includes('set_err(err, "find"'), 'non-miss find failures must attach the bun stderr detail');
  });

  it('seal failures carry bun stderr, never a miss code', { timeout: 30_000 }, () => {
    const sealBody = src.slice(src.indexOf('moltarc_chunk_seal'));
    assert.ok(sealBody.includes('set_err(err, "seal"'), 'seal failures must attach the bun stderr detail');
    assert.ok(!sealBody.includes('return 1;'), 'seal has no miss path: every nonzero exit is an error, never NULL-like');
  });
});
