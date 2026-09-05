// p2p delta sync: two live nodes on localhost, handshake summaries, want by
// sha, chunk transfer with resume, idempotent apply. kill+resume included.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { sha256hex } from '../src/chunk.js';
import { loadManifest } from '../src/manifest.js';
import { verifyAll } from '../src/verify.js';
import { startNode, syncFromPeer } from '../src/p2p.js';
import { scratch, writeHotLog } from './util.js';

function warmBytes(dir: string, name: string): Buffer {
  return readFileSync(join(dir, 'warm', name));
}

describe('p2p transport', () => {
  it('syncs delta between two live nodes on localhost', { timeout: 60_000 }, async () => {
    const dir = scratch('p2p-delta');
    const { hotDb } = writeHotLog(dir, { rows: 3000, uniqueBodies: true });
    const aDir = join(dir, 'node-a');
    const bDir = join(dir, 'node-b');
    const r = await seal({ hotDb, outDir: aDir, targetBytes: 16 * 1024 });
    assert.ok(r.chunks.length >= 2, `need >=2 chunks, got ${r.chunks.length}`);
    const a = startNode({ outDir: aDir, port: 0, blockBytes: 4096 });
    try {
      const first = await syncFromPeer(a.url, bDir, { blockBytes: 4096 });
      assert.equal(first.received.length, r.chunks.length);
      assert.equal(first.resumed, false);
      const vb = verifyAll(bDir);
      assert.ok(vb.ok, `b verifies clean, bad=${vb.bad.join(',')}`);
      const ma = loadManifest(aDir).manifest;
      const mb = loadManifest(bDir).manifest;
      assert.equal(mb.chunks.length, ma.chunks.length);
      for (const e of ma.chunks) {
        assert.equal(sha256hex(warmBytes(bDir, e.file)), e.sha256);
      }
      // idempotent re-sync: nothing new, manifest entries never duplicate.
      const second = await syncFromPeer(a.url, bDir, { blockBytes: 4096 });
      assert.equal(second.received.length, 0);
      const mb2 = loadManifest(bDir).manifest;
      assert.equal(mb2.chunks.length, ma.chunks.length);
      const shas = mb2.chunks.map((e) => e.sha256);
      assert.equal(new Set(shas).size, shas.length);
      assert.ok(existsSync(hotDb), 'source never deleted by sync');
    } finally {
      a.stop();
    }
  });

  it('kills mid-transfer then resumes to a complete verified copy', { timeout: 60_000 }, async () => {
    const dir = scratch('p2p-resume');
    const { hotDb } = writeHotLog(dir, { rows: 6000, uniqueBodies: true });
    const aDir = join(dir, 'node-a');
    const bDir = join(dir, 'node-b');
    const r = await seal({ hotDb, outDir: aDir, targetBytes: 8 * 1024 });
    assert.ok(r.chunks.length >= 2, `need >=2 chunks, got ${r.chunks.length}`);
    const killer = startNode({ outDir: aDir, port: 0, blockBytes: 1024, failAtBytes: 3000 });
    try {
      await assert.rejects(syncFromPeer(killer.url, bDir, { blockBytes: 1024 }), /connection lost mid-transfer/);
    } finally {
      killer.stop();
    }
    const partials = readdirSync(bDir).filter((f) => f.startsWith('.p2p-state-'));
    const parts = readdirSync(join(bDir, 'warm')).filter((f) => f.endsWith('.part'));
    assert.ok(partials.length >= 1 || parts.length >= 1, 'kill leaves partial bytes plus a resume journal');
    const a = startNode({ outDir: aDir, port: 0, blockBytes: 1024 });
    try {
      const done = await syncFromPeer(a.url, bDir, { blockBytes: 1024 });
      assert.ok(done.resumed, 'second run resumes from surviving offsets');
      assert.equal(readdirSync(bDir).filter((f) => f.startsWith('.p2p-state-')).length, 0);
      assert.equal(readdirSync(join(bDir, 'warm')).filter((f) => f.endsWith('.part')).length, 0);
      const v = verifyAll(bDir);
      assert.ok(v.ok, `resumed copy verifies clean, bad=${v.bad.join(',')}`);
      const ma = loadManifest(aDir).manifest;
      const mb = loadManifest(bDir).manifest;
      assert.equal(mb.chunks.length, ma.chunks.length);
      for (const e of ma.chunks) {
        assert.equal(sha256hex(warmBytes(bDir, e.file)), e.sha256);
      }
      void done;
    } finally {
      a.stop();
    }
  });
});
