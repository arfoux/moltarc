// Regression: encodeChunk sorts rows by seq, not ts. A clock correction or
// backfill makes ts non-monotonic in seq order; the header must span the real
// min/max or decodeChunk rejects the chunk it just wrote (quarantine).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeChunk, encodeChunk, type HotRow } from '../src/chunk.js';

const row = (id: string, seq: number, ts: number): HotRow => ({
  device_id: 'dev-01', seq, ts, id, table: 'events', body: `body-${id}`,
});

describe('encodeChunk timestamp range', () => {
  it('spans all rows when ts is non-monotonic in seq order', { timeout: 30_000 }, () => {
    const rows = [row('a', 1, 300), row('b', 2, 100), row('c', 3, 200)];
    const { header, rows: decoded } = decodeChunk(encodeChunk('events', rows));
    assert.equal(header.tsMin, 100n);
    assert.equal(header.tsMax, 300n);
    assert.deepEqual(decoded.map((r) => r.id), ['a', 'b', 'c']);
    assert.deepEqual(decoded.map((r) => r.ts), [300, 100, 200]);
  });

  it('keeps first/last behaviour for monotonic timestamps', { timeout: 30_000 }, () => {
    const rows = [row('a', 1, 100), row('b', 2, 200), row('c', 3, 300)];
    const { header } = decodeChunk(encodeChunk('events', rows));
    assert.equal(header.tsMin, 100n);
    assert.equal(header.tsMax, 300n);
  });
});
