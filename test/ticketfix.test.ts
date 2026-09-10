// claimfix regression: CSPRNG nonce, O(1) use with no bloom rebuild and no
// try pollution, persist-or-lose snapshot contract, single sha256hex owner.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { issueClaim, ClaimStore } from '../src/claim.js';
import { sha256hex } from '../src/chunk.js';
import * as cas from '../src/cas.js';
import { scratch } from './util.js';

describe('claimfix', () => {
  it('nonce is CSPRNG: identical inputs get distinct nonces with Math.random stubbed', { timeout: 30_000 }, () => {
    const realRandom = Math.random;
    Math.random = () => 0.5;
    try {
      const a = issueClaim(1000, 1_700_000_000_000);
      const b = issueClaim(1000, 1_700_000_000_000);
      assert.match(a.nonce, /^[0-9a-f]{16}$/, 'nonce is 8 CSPRNG bytes as hex');
      assert.match(b.nonce, /^[0-9a-f]{16}$/);
      assert.notEqual(a.nonce, b.nonce, 'Math.random stub cannot force a collision');
      assert.notEqual(a.id, b.id);
    } finally {
      Math.random = realRandom;
    }
  });

  it('nonce generation never touches Math.random', { timeout: 30_000 }, () => {
    const realRandom = Math.random;
    Math.random = () => { throw new Error('Math.random must not be called'); };
    try {
      const v = issueClaim(1000, 1_700_000_000_000);
      assert.match(v.nonce, /^[0-9a-f]{16}$/);
    } finally {
      Math.random = realRandom;
    }
  });

  it('use-all stays linear: no per-use bloom rebuild', { timeout: 30_000 }, () => {
    const N = 5000;
    const s = new ClaimStore();
    const ids: string[] = [];
    for (let i = 0; i < N; i++) ids.push(s.issue(1000, 1_700_000_000_000, `fix-${i}`).id);
    const t0 = performance.now();
    for (const id of ids) assert.equal(s.use(id).ok, true);
    const dt = performance.now() - t0;
    assert.ok(dt < 10_000, `use-all N=${N} took ${dt.toFixed(0)}ms (quadratic bloom rebuild takes ~25s)`);
    assert.equal(s.use(ids[0]).reason, 'double-use', 'exact set still decides after bulk use');
  });

  it('unknown ids are rejected before any try is recorded', { timeout: 30_000 }, () => {
    const s = new ClaimStore();
    assert.deepEqual(s.use('t-deadbeefcafe'), { ok: false, reason: 'unknown' });
    assert.equal(s.triesOf('t-deadbeefcafe'), 0, 'unissued ids must not pollute the tries map');
  });

  it('usage history is persist-or-lose across restarts', { timeout: 30_000 }, () => {
    const s = new ClaimStore();
    const v = s.issue(1000, 1_700_000_000_000, 'persist-1');
    assert.equal(s.use(v.id).ok, true);
    const amnesiac = new ClaimStore();
    amnesiac.load(v);
    assert.equal(amnesiac.use(v.id).ok, true, 'fresh store without snapshot loses usage history');
    const restored = ClaimStore.fromJSON(s.toJSON());
    assert.equal(restored.use(v.id).reason, 'double-use', 'snapshot restore keeps spent claims spent');
  });

  it('cas reuses chunk.js sha256hex: single owner, no local fork', { timeout: 30_000 }, () => {
    assert.ok(!('sha256hex' in cas), 'cas.js must not export its own sha256hex fork');
    const root = join(scratch('cas-single-hash'), 'cas');
    const bytes = randomBytes(1024);
    assert.equal(cas.casPut(root, bytes), sha256hex(bytes));
    assert.ok(cas.casGet(root, sha256hex(bytes)).equals(bytes));
  });
});
