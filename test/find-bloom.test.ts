// bloom bomb fail-open: an over-cap (>1MB) bitset must never prune a chunk.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BLOOM_MAX_BYTES, bloomCheckScaled } from '../src/find.js';

describe('bloom over-cap fail-open', () => {
  it('bomb bitset (>1MB) fails OPEN even when every probe bit is zero', { timeout: 30_000 }, () => {
    // All zeros: would prune every key if probed, so `true` proves fail-open.
    const bomb = Buffer.alloc(BLOOM_MAX_BYTES + 8).toString('base64');
    assert.equal(bloomCheckScaled(bomb, 'trx-00000001'), true);
    assert.equal(bloomCheckScaled(bomb, 'zzz-no-such-key-999'), true);
  });

  it('at-cap bitset still probes (boundary)', { timeout: 30_000 }, () => {
    const edge = Buffer.alloc(BLOOM_MAX_BYTES).toString('base64');
    assert.equal(bloomCheckScaled(edge, 'trx-00000001'), false);
  });
});
