// claim single-spend permit: offline double-use + sync reconcile report.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { issueClaim, ClaimStore } from '../src/claim.js';

describe('claim', () => {
  it('uses once, then detects offline double-use', { timeout: 30_000 }, () => {
    const s = new ClaimStore();
    const v = s.issue(15000, 1_700_000_000_000, 'n1');
    assert.equal(s.use(v.id).ok, true);
    const again = s.use(v.id);
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'double-use');
    assert.equal(s.triesOf(v.id), 2);
  });

  it('rejects unknown ids and round-trips offline state', { timeout: 30_000 }, () => {
    const s = new ClaimStore();
    assert.deepEqual(s.use('t-deadbeefcafe'), { ok: false, reason: 'unknown' });
    const v = s.issue(25000, 1_700_000_000_000, 'n2');
    s.use(v.id);
    const copy = ClaimStore.fromJSON(s.toJSON());
    assert.equal(copy.isUsed(v.id), true);
    assert.equal(copy.use(v.id).reason, 'double-use');
  });

  it('reconcile splits clean / double-used / local-only / remote-only', { timeout: 30_000 }, () => {
    const s = new ClaimStore();
    const a = s.issue(1000, 1, 'a');
    const b = s.issue(2000, 1, 'b');
    const c = s.issue(3000, 1, 'c');
    s.use(a.id);
    s.use(b.id);
    s.use(b.id); // double-use offline
    const rep = s.reconcile([a.id, 't-external0000']);
    assert.deepEqual(rep.clean, [a.id]);
    assert.deepEqual(rep.doubleUsed, [b.id]);
    assert.deepEqual(rep.localOnly, [b.id]);
    assert.deepEqual(rep.remoteOnly, ['t-external0000']);
    assert.ok(!rep.clean.includes(c.id), 'never-used stays out');
  });

  it('issue is deterministic and validates input', { timeout: 30_000 }, () => {
    assert.equal(issueClaim(500, 9, 'x').id, issueClaim(500, 9, 'x').id);
    assert.throws(() => issueClaim(0), /> 0/);
    assert.throws(() => issueClaim(5, 1, ''), /nonce/);
  });

  it('ignores unknown ids in tries and validates snapshots', { timeout: 30_000 }, () => {
    const s = new ClaimStore();
    assert.deepEqual(s.use('t-deadbeefcafe'), { ok: false, reason: 'unknown' });
    assert.equal(s.triesOf('t-deadbeefcafe'), 0);
    assert.throws(
      () => ClaimStore.fromJSON({ issued: [{ id: 'x', value: NaN, issuedAt: 1, nonce: 'n' }], used: [], tries: [] }),
      /invalid claim/,
    );
    assert.throws(() => ClaimStore.fromJSON({ issued: [], used: 'nope' } as never), /arrays/);
  });
});
