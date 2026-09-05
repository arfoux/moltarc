// sensor lossy-log: downsample + anomaly flag + quarantine-cold routing.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { downsample, flagAnomalies, routeQuarantine, anomalyBloom, anomalyBloomCheck, bucketsToRows, packSensor, unpackSensor } from '../src/sensor.js';
import type { SensorPoint } from '../src/sensor.js';

function pts(n: number, base = 1_700_000_000_000, step = 1000, val = 10): SensorPoint[] {
  return Array.from({ length: n }, (_, i) => ({ ts: base + i * step, value: val, id: `s-${i}` }));
}

describe('sensor', () => {
  it('downsamples into fixed buckets with min/max/avg', { timeout: 30_000 }, () => {
    const b = downsample(pts(10, 0, 1000, 5).map((p, i) => ({ ...p, value: i + 1 })), 5000);
    assert.equal(b.length, 2);
    assert.equal(b[0].count, 5);
    assert.equal(b[0].min, 1);
    assert.equal(b[0].max, 5);
    assert.equal(b[0].avg, 3);
    assert.equal(b[1].first, 6);
    assert.equal(b[1].last, 10);
  });

  it('flags a spike against a flat baseline, never the baseline itself', { timeout: 30_000 }, () => {
    const calm = pts(12, 0, 1000, 20);
    const spike: SensorPoint = { ts: 12_000, value: 200, id: 's-spike' };
    const flags = flagAnomalies([...calm, spike], { window: 8, z: 3 });
    assert.equal(flags.slice(0, 12).every((f) => f === false), true);
    assert.equal(flags[12], true);
  });

  it('routes stale and anomalous points to cold, keeps the rest hot', { timeout: 30_000 }, () => {
    const p = pts(6, 0, 1000, 10);
    const flags = [false, false, true, false, false, false];
    const r = routeQuarantine(p, flags, { coldBefore: 2000, anomalyToCold: true });
    // ts 0,1000 stale; ts 2000 anomalous; rest hot
    assert.equal(r.cold.length, 3);
    assert.equal(r.hot.length, 3);
    assert.deepEqual(r.quarantined.map((q) => q.id), ['s-2']);
    const bloom = anomalyBloom(p, flags);
    assert.equal(anomalyBloomCheck(bloom, 's-2'), true);
    assert.equal(anomalyBloomCheck(bloom, 's-0'), false);
  });

  it('packs buckets through the chunk codec and round-trips', { timeout: 30_000 }, () => {
    const b = downsample(pts(8, 0, 1000, 7), 4000);
    const buf = packSensor('sensor', bucketsToRows(b));
    const out = unpackSensor(buf);
    assert.equal(out.headerRows, b.length);
    assert.equal(out.rows.length, b.length);
    assert.ok(out.rows[0].body.includes('"count":4'));
  });

  it('rejects bad bucket size and flag length mismatch', { timeout: 30_000 }, () => {
    assert.throws(() => downsample(pts(2), 0), /> 0/);
    assert.throws(() => routeQuarantine(pts(2), [true]), /mismatch/);
  });
});
