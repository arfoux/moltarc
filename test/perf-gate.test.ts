// perf gate: tripwire against decode-bomb regressions.
// Ratio gate 6-12x is the deterministic gate (machine-independent).
// Timing is machine-specific and informational only; only the ratio is gated.
// bench/perf.ts likewise must not assert timing — timing varies by hardware.
import { readdirSync, statSync } from 'fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { findTrx } from '../src/find.js';
import { generateMixedCorpus, measureArchive } from '../bench/mixed-corpus.js';
import { scratch, writeHotLog } from './util.js';

describe('perf gate', () => {
  it('single-chunk find via ratio gate 6-12x (timing logged only)', { timeout: 60_000 }, async () => {
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
    // Timing is machine-specific; log only — do not assert. Only ratio is the deterministic gate.
    console.log(`perf-gate: find latency ${ms.toFixed(1)}ms (informational, not gated)`);
  });
  it('mixed-corpus byte baselines within +-3% (ratio 6-12x, never wall-ms)', { timeout: 120_000 }, async () => {
    // Baselines read from bench/measured.json and hardcoded so CI fails on
    // byte drift until a bench re-run + review updates them. No timing is
    // measured or asserted here: wall-ms varies by machine.
    const MIXED_WARM_BYTES = 246737; // bench/measured.json mixed.mixedWarmBytes
    const DICT_SAVED_BYTES = 2003; // bench/measured.json dict.savedBytes
    const dir = scratch('perf-gate-bytes');
    const corpus = generateMixedCorpus(dir, 6000, 7);
    const mixed = await measureArchive(corpus.mixedPath, join(dir, 'arch-mixed'));
    console.log(`perf-gate-bytes: mixed input=${mixed.inputBytes}B warm=${mixed.warmBytes}B ratio=${mixed.ratio.toFixed(1)}x`);
    assert.ok(mixed.ratio >= 6 && mixed.ratio <= 12, `warm ratio band 6-12x, got ${mixed.ratio.toFixed(1)}x`);
    assert.ok(
      Math.abs(mixed.warmBytes - MIXED_WARM_BYTES) <= MIXED_WARM_BYTES * 0.03,
      `mixed warm bytes drift: got ${mixed.warmBytes}B, baseline ${MIXED_WARM_BYTES}B +-3%`,
    );
    // Dict baseline corpus matches bench/dict-bench.ts defaults (rows=12000
    // seed=7) and bench/measured.json dict.savedBytes, not the mixed corpus.
    const dictTargetBytes = 16 * 1024;
    const dictBase = generateMixedCorpus(join(dir, 'dict-base'), 12000, 7);
    const plain = await measureArchive(dictBase.textPath, join(dir, 'arch-plain'), { trainDict: false, targetBytes: dictTargetBytes });
    const trained = await measureArchive(dictBase.textPath, join(dir, 'arch-dict'), { trainDict: true, targetBytes: dictTargetBytes });
    const saved = plain.warmBytes - trained.warmBytes;
    console.log(`perf-gate-bytes: dict plain=${plain.warmBytes}B trained=${trained.warmBytes}B saved=${saved}B`);
    assert.ok(
      Math.abs(saved - DICT_SAVED_BYTES) <= DICT_SAVED_BYTES * 0.03,
      `dict saved bytes drift: got ${saved}B, baseline ${DICT_SAVED_BYTES}B +-3%`,
    );
  });
});
