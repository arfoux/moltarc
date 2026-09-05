// combined sensor + ticket + bundle: quarantine a spike, spend a voucher,
// pack both reports as one hash-linked bundle.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { downsample, flagAnomalies, routeQuarantine, bucketsToRows, packSensor, unpackSensor } from '../src/sensor.js';
import { TicketStore } from '../src/ticket.js';
import { packBundle, verifyBundle } from '../src/bundle.js';
import { scratch } from './util.js';

describe('sensor+ticket+bundle', () => {
  it('quarantine + voucher + hash-linked pack verify clean', { timeout: 30_000 }, () => {
    const base = 1_700_000_000_000;
    const points = Array.from({ length: 20 }, (_, i) => ({
      ts: base + i * 1000,
      value: i === 19 ? 500 : 25,
      id: `tank-${i}`,
    }));
    const flags = flagAnomalies(points, { window: 8, z: 3 });
    assert.equal(flags[19], true);
    const route = routeQuarantine(points, flags);
    assert.equal(route.quarantined.length, 1);

    const buckets = downsample(points, 10_000);
    const chunk = packSensor('sensor', bucketsToRows(buckets));
    assert.equal(unpackSensor(chunk).rows.length, buckets.length);

    const store = new TicketStore();
    const voucher = store.issue(50000, base, 'qurban-1');
    assert.equal(store.redeem(voucher.id).ok, true);
    const rep = store.reconcile([voucher.id]);
    assert.deepEqual(rep.clean, [voucher.id]);

    const dir = scratch('stb-combined');
    const text = `posko: quarantined=${route.quarantined.length} spent=${voucher.id}`;
    packBundle(dir, text, [
      { name: 'sensor.chunk', data: chunk },
      { name: 'reconcile.json', data: Buffer.from(JSON.stringify(rep)) },
    ]);
    const v = verifyBundle(dir);
    assert.equal(v.ok, true);
    assert.equal(v.errors.length, 0);
  });
});
