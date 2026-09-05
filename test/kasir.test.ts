// Kasir demo flow: 50 struk seal, ship, find one, shrink proven.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runKasirDemo } from '../examples/kasir-demo.js';
import { scratch } from './util.js';

describe('kasir demo', () => {
  it('seals 50 struk, ships, finds one, archive smaller than input', async () => {
    const r = await runKasirDemo(scratch('kasir'));
    assert.equal(r.row.id, r.targetId);
    assert.ok(r.shipped >= 1);
    assert.ok(r.ratio >= 3, `expected visible shrink, got ${r.ratio.toFixed(1)}x`);
    console.log(`kasir-demo: ratio=${r.ratio.toFixed(1)}x`);
  });
});
