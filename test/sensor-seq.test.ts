// Regression: bucketsToRows seq must be globally monotonic per device.
// Pre-fix logic used `seq: i + 1` per call, so two sequential batches both
// produced seqs [1..n]; the seal-time dedupe keyed on
// syntheticId(table, device, seq) (src/seal.ts:432-435, seen.set(key, r))
// then overwrote batch 1 with batch 2. This test FAILS pre-fix (second
// batch seqs overlap the first) and passes post-fix.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { downsample, bucketsToRows, resetSensorSeqCounters } from '../src/sensor.js';
import type { SensorPoint } from '../src/sensor.js';

function pts(n: number, base: number): SensorPoint[] {
  return Array.from({ length: n }, (_, i) => ({ ts: base + i * 1000, value: 10, id: `q-${base}-${i}` }));
}

describe('sensor-seq monotonic', () => {
  it('two sequential batches do not overwrite each other via dedupe', { timeout: 30_000 }, () => {
    resetSensorSeqCounters();
    const b1 = downsample(pts(8, 0), 4000); // 2 buckets
    const b2 = downsample(pts(8, 100_000), 4000); // 2 buckets, distinct t0
    const r1 = bucketsToRows(b1);
    const r2 = bucketsToRows(b2);
    // Globally monotonic: batch 2 continues after batch 1.
    assert.deepEqual(r1.map((r) => r.seq), [1, 2]);
    assert.deepEqual(r2.map((r) => r.seq), [3, 4]);
    // Simulate seal dedupe: last-write-wins per synthetic key must keep all 4.
    const seen = new Map<string, string>();
    for (const r of [...r1, ...r2]) seen.set(`${r.table}|${r.device_id}|${r.seq}`, r.body);
    assert.equal(seen.size, r1.length + r2.length);
  });

  it('startAfter seeds the counter (restart recovery)', { timeout: 30_000 }, () => {
    resetSensorSeqCounters();
    const b = downsample(pts(8, 0), 4000);
    const rows = bucketsToRows(b, 'sensor', 'sensor-01', 10);
    assert.deepEqual(rows.map((r) => r.seq), [11, 12]);
  });
});
