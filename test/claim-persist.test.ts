import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaimStore } from '../src/claim.js';

// LOCKED DOCUMENTATION: ClaimStore is explicitly ephemeral. A restart
// without toJSON/fromJSON loses usage history (spent becomes spendable).
// This test pins both halves: restore preserves, fresh restart loses.
describe('claim persist (ephemeral, documented)', () => {
  it('snapshot restore survives restart; fresh store does not', { timeout: 30_000 }, () => {
    const a = new ClaimStore();
    const c = a.issue(10, 1000, 'n1', undefined);
    assert.equal(a.use(c.id).ok, true);
    const snap = a.toJSON();
    // restart WITH restore: double-use still detected
    const b = ClaimStore.fromJSON(JSON.parse(JSON.stringify(snap)));
    assert.deepEqual(b.use(c.id), { ok: false, reason: 'double-use' });
    // restart WITHOUT restore (fresh + load claim only): spent again
    const fresh = new ClaimStore();
    fresh.load(c);
    assert.equal(fresh.use(c.id).ok, true);
  });
});
