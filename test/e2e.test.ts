// End-to-end: fielog JSONL -> seal -> ship to relay dir -> find one trx.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runE2E } from '../examples/e2e.js';
import { scratch } from './util.js';

describe('e2e fielog flow', () => {
  it('seals, ships, and finds a single trx', { timeout: 30_000 }, async () => {
    const r = await runE2E(scratch('e2e'));
    assert.equal(r.row.id, r.targetId);
    assert.ok(r.shipped >= 1, 'at least one chunk shipped');
    assert.equal(r.relayChunks, r.shipped);
    assert.equal(r.chunksFetched, 1);
  });
});
