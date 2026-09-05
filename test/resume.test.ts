// Resume mid-ship: kill the transport partway, state journal survives, second run completes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { ship, readRelayIndex } from '../src/ship.js';
import { sha256hex } from '../src/chunk.js';
import { scratch, writeHotLog } from './util.js';

describe('ship resume', () => {
  it('dies mid-chunk then resumes to a complete verified relay', { timeout: 30_000 }, async () => {
    const dir = scratch('resume');
    const { hotDb } = writeHotLog(dir, { rows: 3000, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    // Small target => several chunks so the kill lands mid-shipment.
    const r = await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
    assert.ok(r.chunks.length >= 2, `need >=2 chunks, got ${r.chunks.length}`);
    // First attempt: transport dies mid-first-chunk (no retries).
    await assert.rejects(
      ship({ outDir, relayDir, blockBytes: 512, failAtBytes: 1500, maxRetries: 0, baseDelayMs: 1 }),
      /injected transport failure/,
    );
    const partials = readdirSync(relayDir).filter((f) => f.startsWith('.ship-state-'));
    assert.ok(partials.length >= 1, 'crash leaves a resume journal behind');

    // Second run resumes and finishes everything.
    const done = await ship({ outDir, relayDir, baseDelayMs: 1 });
    const idx = readRelayIndex(relayDir);
    assert.equal(Object.keys(idx.chunks).length, r.chunks.length);
    assert.equal(readdirSync(relayDir).filter((f) => f.startsWith('.ship-state-')).length, 0);
    void done;
    // Every relay byte matches the sealed chunk hash.
    for (const c of r.chunks) {
      const name = c.split(/[\\/]/).pop() as string;
      const relayed = readFileSync(join(relayDir, 'chunks', name));
      assert.equal(sha256hex(relayed), sha256hex(readFileSync(c)));
    }
    assert.ok(existsSync(hotDb), 'source never deleted by ship');
  });
});
