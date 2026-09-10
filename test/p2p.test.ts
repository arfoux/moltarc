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
function isContentionError(e: unknown): boolean {
  let msg: string;
  if (e !== null && typeof e === 'object' && 'message' in e) {
    const m = e.message;
    msg = typeof m === 'string' ? m : String(e);
  } else {
    msg = String(e);
  }
  return /EADDRINUSE|EBUSY|ENOSPC|EMFILE|EAGAIN|ENOTEMPTY|EPERM|EBADF|ECONN/i.test(msg);
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt === attempts || !isContentionError(e)) throw e;
      // Real delay: retry backs off against live OS resource pressure (errno-coded only: lock/timeout/product errors fail loud); fake timers cannot advance kernel state.
      await new Promise<void>((r) => setTimeout(r, 200 * attempt));
    }
  }
  throw last;
}


describe('p2p transport', () => {
  it('syncs delta between two live nodes on localhost', { timeout: 60_000 }, async () => {
    await withRetry(async () => {
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
  });

  it('kills mid-transfer then resumes to a complete verified copy', { timeout: 60_000 }, async () => {
    await withRetry(async () => {
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
});

describe('p2p hardening', () => {
  function startEvilServer(script: (send: (m: unknown) => void) => void): { url: string; stop: () => void } {
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response('evil p2p', { status: 426 });
      },
      websocket: {
        message(ws, raw) {
          let msg: unknown;
          try {
            msg = JSON.parse(String(raw));
          } catch {
            return;
          }
          if (!msg || typeof msg !== 'object' || !('t' in msg) || msg.t !== 'hello') return;
          const send = (m: unknown) => {
            try {
              ws.send(JSON.stringify(m));
            } catch {
              /* peer gone */
            }
          };
          send({ t: 'welcome', have: [] });
          script(send);
        },
      },
    });
    return { url: `ws://127.0.0.1:${server.port}/p2p`, stop: () => server.stop() };
  }

  it('drops malicious wire entries without storing or escaping warm/', { timeout: 60_000 }, async () => {
    await withRetry(async () => {
      const dir = scratch('p2p-evil');
      const bDir = join(dir, 'node-b');
      const goodSha = sha256hex(Buffer.from('good-bytes'));
      const evil = startEvilServer((send) => {
        const badEntries = [
          { file: '../evil.chk', sha256: goodSha, bytes: 4 },
          { file: 'evil.chk', sha256: 'not-hex', bytes: 4 },
        ];
        for (const e of badEntries) {
          send({ t: 'meta', entry: e, blocks: 1, blockBytes: 1024 });
          send({ t: 'block', sha256: e.sha256, offset: 0, data: Buffer.from('evil').toString('base64') });
          send({ t: 'end', sha256: e.sha256 });
        }
        send({ t: 'endbatch' });
      });
      try {
        const r = await syncFromPeer(evil.url, bDir, { blockBytes: 1024 });
        assert.equal(r.received.length, 0);
        assert.ok(r.failed.length >= 2, `malicious entries surface in failed, got ${JSON.stringify(r.failed)}`);
        assert.ok(!existsSync(join(dir, 'evil.chk')), 'path-traversal entry escaped warm/');
        assert.ok(!existsSync(join(bDir, 'evil.chk')), 'bad-sha entry stored at top level');
        const warm = existsSync(join(bDir, 'warm')) ? readdirSync(join(bDir, 'warm')) : [];
        assert.ok(warm.every((f) => !f.includes('evil')), `nothing evil stored in warm/: ${warm.join(',')}`);
      } finally {
        evil.stop();
      }
    });
  });

  it('rejects oversize blocks that exceed entry.bytes and blockBytes*4', { timeout: 60_000 }, async () => {
    await withRetry(async () => {
      const dir = scratch('p2p-oversize');
      const bDir = join(dir, 'node-b');
      const sha = sha256hex(Buffer.from('big-bytes'));
      const evil = startEvilServer((send) => {
        send({ t: 'meta', entry: { file: 'big.chk', sha256: sha, bytes: 16 }, blocks: 1, blockBytes: 1024 });
        send({ t: 'block', sha256: sha, offset: 0, data: Buffer.alloc(32 * 1024, 7).toString('base64') });
        send({ t: 'end', sha256: sha });
        send({ t: 'endbatch' });
      });
      try {
        await assert.rejects(syncFromPeer(evil.url, bDir, { blockBytes: 1024 }), /oversize/);
        assert.ok(!existsSync(join(bDir, 'warm', 'big.chk')), 'oversize chunk must not land as a usable chunk');
      } finally {
        evil.stop();
      }
    });
  });

  it('token guards sync: wrong token syncs nothing, right token syncs', { timeout: 60_000 }, async () => {
    await withRetry(async () => {
      const dir = scratch('p2p-token');
      const { hotDb } = writeHotLog(dir, { rows: 500, uniqueBodies: true });
      const aDir = join(dir, 'node-a');
      const bDir = join(dir, 'node-b');
      await seal({ hotDb, outDir: aDir, targetBytes: 16 * 1024 });
      const a = startNode({ outDir: aDir, port: 0, token: 'node-1' });
      try {
        await assert.rejects(syncFromPeer(a.url, bDir, { blockBytes: 1024, timeoutMs: 8000 }), /connection lost|timeout/);
        const allowed = await syncFromPeer(a.url, bDir, { blockBytes: 1024, token: 'node-1', timeoutMs: 15000 });
        assert.ok(allowed.received.length >= 1, 'peer with token syncs');
      } finally {
        a.stop();
      }
    });
  });

  it('allowlist refuses serve to unlisted peers', { timeout: 60_000 }, async () => {
    await withRetry(async () => {
      const dirA = scratch('p2p-allow-a');
      const dirB = scratch('p2p-allow-b');
      const { hotDb: hotA } = writeHotLog(dirA, { rows: 500, uniqueBodies: true });
      const aDir = join(dirA, 'node-a');
      const bDir = join(dirB, 'node-b');
      await seal({ hotDb: hotA, outDir: aDir, targetBytes: 16 * 1024 });
      const other = sha256hex(Buffer.from('node-other', 'utf8'));
      const a = startNode({ outDir: aDir, port: 0, token: 'node-1', allowPeers: [other] });
      try {
        await assert.rejects(syncFromPeer(a.url, bDir, { blockBytes: 1024, token: 'node-1', timeoutMs: 8000 }), /not allowed|connection lost|timeout/);
      } finally {
        a.stop();
      }
    });
  });

  it('serve:false fetches without leaking local chunks to the peer', { timeout: 60_000 }, async () => {
    await withRetry(async () => {
      const dirA = scratch('p2p-serve-a');
      const dirB = scratch('p2p-serve-b');
      const { hotDb: hotA } = writeHotLog(dirA, { rows: 3000, uniqueBodies: true });
      const { hotDb: hotB } = writeHotLog(dirB, { rows: 3000, uniqueBodies: true, table: 'returns' });
      const aDir = join(dirA, 'node-a');
      const bDir = join(dirB, 'node-b');
      const ra = await seal({ hotDb: hotA, outDir: aDir, targetBytes: 16 * 1024 });
      const rb = await seal({ hotDb: hotB, outDir: bDir, targetBytes: 16 * 1024 });
      assert.ok(ra.chunks.length >= 1 && rb.chunks.length >= 1);
      const before = readdirSync(join(aDir, 'warm')).sort();
      const bFiles = readdirSync(join(bDir, 'warm'));
      assert.ok(bFiles.some((f) => !before.includes(f)), 'setup: B holds a chunk A lacks');
      const a = startNode({ outDir: aDir, port: 0, blockBytes: 4096 });
      try {
        const r = await syncFromPeer(a.url, bDir, { blockBytes: 4096, fetchOnly: true });
        assert.deepEqual(readdirSync(join(aDir, 'warm')).sort(), before, 'fetch-only served nothing back');
        const v = verifyAll(bDir);
        assert.ok(v.ok, `fetch-only copy verifies clean, bad=${v.bad.join(',')}`);
      } finally {
        a.stop();
      }
    });
  });

  it('rejects syncs that exceed the aggregate session cap', { timeout: 60_000 }, async () => {
    await withRetry(async () => {
      const dir = scratch('p2p-sesscap');
      const { hotDb } = writeHotLog(dir, { rows: 500, uniqueBodies: true });
      const aDir = join(dir, 'node-a');
      const bDir = join(dir, 'node-b');
      const r = await seal({ hotDb, outDir: aDir, targetBytes: 16 * 1024 });
      assert.ok(r.chunks.length >= 1);
      const a = startNode({ outDir: aDir, port: 0, blockBytes: 1024 });
      try {
        await assert.rejects(syncFromPeer(a.url, bDir, { blockBytes: 1024, maxSessionBytes: 1 }), /session cap/);
      } finally {
        a.stop();
      }
    });
  });
});

describe('p2p bind retry', () => {
  it('retries Bun.serve on EADDRINUSE up to 5x; other errors throw at once', { timeout: 30_000 }, () => {
    const dir = scratch('p2p-bindretry');
    const bunCtl = Bun as unknown as { serve: typeof Bun.serve };
    const realServe = bunCtl.serve;
    try {
      // Transient contention: two EADDRINUSE then a bind.
      let flaky = 0;
      bunCtl.serve = ((opts: Parameters<typeof Bun.serve>[0]) => {
        flaky++;
        if (flaky <= 2) {
          const e = new Error('simulated EADDRINUSE') as NodeJS.ErrnoException;
          e.code = 'EADDRINUSE';
          throw e;
        }
        return realServe(opts);
      }) as typeof Bun.serve;
      const n = startNode({ outDir: join(dir, 'a1'), port: 0 });
      try {
        assert.equal(flaky, 3, 'two EADDRINUSE retries then a successful bind');
        assert.ok(n.port > 0, `bound port ${n.port}`);
      } finally {
        n.stop();
      }
      // Persistent contention: exactly 5 attempts, then the error surfaces.
      let stuck = 0;
      bunCtl.serve = (() => {
        stuck++;
        const e = new Error('port still busy') as NodeJS.ErrnoException;
        e.code = 'EADDRINUSE';
        throw e;
      }) as typeof Bun.serve;
      assert.throws(() => startNode({ outDir: join(dir, 'a2'), port: 0 }), /port still busy/);
      assert.equal(stuck, 5, 'gives up after 5 attempts');
      // Unrelated failures are never retried.
      let other = 0;
      bunCtl.serve = (() => {
        other++;
        throw new Error('boom');
      }) as typeof Bun.serve;
      assert.throws(() => startNode({ outDir: join(dir, 'a3'), port: 0 }), /boom/);
      assert.equal(other, 1, 'non-EADDRINUSE throws at once');
    } finally {
      bunCtl.serve = realServe;
    }
  });
});
