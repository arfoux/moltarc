// Entry demo flow: 50 entries seal, ship, find one, shrink proven.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runLedgerDemo } from '../examples/ledger-demo.js';
import { scratch } from './util.js';

describe('entry demo', () => {
  it('seals 50 entries, ships, finds one, archive smaller than input', { timeout: 30_000 }, async () => {
    const r = await runLedgerDemo(scratch('ledger'));
    assert.equal(r.row.id, r.targetId);
    assert.ok(r.shipped >= 1);
    assert.ok(r.ratio >= 3, `expected visible shrink, got ${r.ratio.toFixed(1)}x`);
    console.log(`ledger-demo: ratio=${r.ratio.toFixed(1)}x`);
  });
});
