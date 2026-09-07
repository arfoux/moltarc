// perf gate: tripwire against decode-bomb and latency-blowup regressions.
// Generous bounds (machine-independent): a healthy archive answers in ms;
// a quadratic/allocation blowup takes seconds or OOMs.
import { readdirSync, statSync } from 'fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { findTrx } from '../src/find.js';
import { scratch, writeHotLog } from './util.js';

describe('perf gate', () => {
  it('single-chunk find answers under 5s on a small archive', { timeout: 60_000 }, async () => {
    const dir = scratch('perf-gate');
    const { hotDb, ids } = writeHotLog(dir, { rows: 3000, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    const r = await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
    assert.ok(r.chunks.length >= 2);
    const inputBytes = statSync(hotDb).size;
    const warmDir = join(outDir, 'warm');
    const warmBytes = readdirSync(warmDir).filter((f: string) => f.endsWith('.chk')).reduce((n, f) => n + statSync(join(warmDir, f)).size, 0);
    const ratio = inputBytes / warmBytes;
    console.log(`perf-gate: input=${inputBytes}B warm=${warmBytes}B ratio=${ratio.toFixed(1)}x`);
    assert.ok(ratio >= 6 && ratio <= 12, `warm ratio band 6-12x, got ${ratio.toFixed(1)}x`);
    const target = ids[Math.floor(ids.length / 2)];
    const t0 = performance.now();
    const found = findTrx({ outDir, trxId: target });
    const ms = performance.now() - t0;
    assert.equal(found.row.id, target);
    assert.ok(ms < 5000, `find took ${ms.toFixed(1)}ms, expected < 5000ms`);
  });
});
