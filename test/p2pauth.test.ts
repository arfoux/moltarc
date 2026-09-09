// p2p PSK auth + node identity regressions: FAIL pre-fix (plain-JSON transport,
// unsigned blocks, anonymous hellos), PASS post-fix. Bun-only, no full suite.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { sha256hex } from '../src/chunk.js';
import { PSK_ENV, resolveNodeId, startNode, syncFromPeer } from '../src/p2p.js';
import { scratch, writeHotLog } from './util.js';

const savedPsk = process.env[PSK_ENV];
afterEach(() => {
  if (savedPsk === undefined) delete process.env[PSK_ENV];
  else process.env[PSK_ENV] = savedPsk;
});
const freshPsk = (): string => randomBytes(32).toString('hex');

describe('p2p PSK handshake', () => {
  it('rejects peers without (or with the wrong) PSK; admits the right PSK', { timeout: 60_000 }, async () => {
    const pskHex = freshPsk();
    const dir = scratch('p2pauth-hs');
    const { hotDb } = writeHotLog(dir, { rows: 500, uniqueBodies: true });
    const aDir = join(dir, 'node-a');
    const bDir = join(dir, 'node-b');
    const r = await seal({ hotDb, outDir: aDir, targetBytes: 16 * 1024 });
    assert.ok(r.chunks.length >= 1);
    process.env[PSK_ENV] = pskHex;
    const a = startNode({ outDir: aDir, port: 0 });
    try {
      delete process.env[PSK_ENV];
      await assert.rejects(
        syncFromPeer(a.url, bDir, { blockBytes: 1024, timeoutMs: 4000 }),
        /connection lost|timeout|auth/i,
        'peer with no PSK must be rejected before any chunk lands',
      );
      assert.equal(readdirSync(join(bDir, 'warm')).length, 0, 'rejected peer receives nothing');
      process.env[PSK_ENV] = freshPsk();
      await assert.rejects(
        syncFromPeer(a.url, bDir, { blockBytes: 1024, timeoutMs: 4000 }),
        /connection lost|timeout|auth/i,
        'peer with the wrong PSK must be rejected',
      );
      process.env[PSK_ENV] = pskHex;
      const ok = await syncFromPeer(a.url, bDir, { blockBytes: 1024, timeoutMs: 15000 });
      assert.ok(ok.received.length >= 1, 'peer with the right PSK syncs');
    } finally {
      a.stop();
    }
  });

  it('auth bypass must fail: forged blocks without a valid HMAC are dropped before parse', { timeout: 60_000 }, async () => {
    const dir = scratch('p2pauth-bypass');
    const aDir = join(dir, 'node-a');
    process.env[PSK_ENV] = freshPsk();
    const a = startNode({ outDir: aDir, port: 0 });
    try {
      const evilSha = sha256hex(Buffer.from('evil-inject-payload'));
      const evilFile = 'evil-inject.chk';
      const closed = new Promise<string>((resolve) => {
        const ws = new WebSocket(a.url);
        const timer = setTimeout(() => {
          try {
            ws.close();
          } catch {
            /* already gone */
          }
          resolve('timeout');
        }, 5000);
        ws.onopen = () => {
          // Attacker speaks plain JSON with no frame and no per-block auth.
          ws.send(JSON.stringify({ t: 'hello', have: [], partials: [] }));
          ws.send(JSON.stringify({ t: 'meta', entry: { file: evilFile, sha256: evilSha, bytes: 4 }, blocks: 1, blockBytes: 1024 }));
          ws.send(JSON.stringify({ t: 'block', sha256: evilSha, offset: 0, data: Buffer.from('evil').toString('base64') }));
        };
        ws.onclose = () => {
          clearTimeout(timer);
          resolve('closed');
        };
        ws.onerror = () => {
          /* close still follows */
        };
      });
      assert.equal(await closed, 'closed', 'PSK-guarded node must drop an unauthenticated connection');
      assert.ok(!existsSync(join(aDir, 'warm', `${evilFile}.part`)), 'forged block bytes must never reach disk');
      assert.ok(!existsSync(join(aDir, `.p2p-state-${evilSha.slice(0, 12)}.json`)), 'forged blocks must leave no resume journal');
      assert.ok(!existsSync(join(aDir, 'warm', evilFile)), 'forged chunk must never materialize');
    } finally {
      a.stop();
    }
  });
});

describe('p2p node identity', () => {
  function readWelcome(url: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        reject(new Error('welcome timeout'));
      }, timeoutMs);
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'hello', have: [], partials: [] }));
      };
      ws.onmessage = (ev) => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        try {
          resolve(JSON.parse(String(ev.data)) as Record<string, unknown>);
        } catch (e) {
          reject(e as Error);
        }
      };
      ws.onerror = () => {
        /* onclose path still settles */
      };
    });
  }

  it('hello/welcome genesis carries node identity; empty nodes stay distinguishable', { timeout: 60_000 }, async () => {
    const dir = scratch('p2pauth-id');
    const a = startNode({ outDir: join(dir, 'node-a'), port: 0 });
    const b = startNode({ outDir: join(dir, 'node-b'), port: 0 });
    try {
      const wa = await readWelcome(a.url);
      const wb = await readWelcome(b.url);
      assert.equal(wa['t'], 'welcome');
      assert.ok(typeof wa['nodeId'] === 'string' && (wa['nodeId'] as string).length > 0, `welcome carries nodeId, got ${JSON.stringify(wa)}`);
      assert.ok(typeof wb['nodeId'] === 'string' && (wb['nodeId'] as string).length > 0, 'second node also identifies itself');
      assert.notEqual(wa['nodeId'], wb['nodeId'], 'two default nodes must not share an identity');
    } finally {
      a.stop();
      b.stop();
    }
  });

  it('sync hello carries the dialer nodeId to the peer', { timeout: 60_000 }, async () => {
    let seen: Record<string, unknown> | undefined;
    const server = Bun.serve({
      port: 0,
      fetch(req, s) {
        if (s.upgrade(req)) return;
        return new Response('p2p-id', { status: 426 });
      },
      websocket: {
        message(ws, raw) {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(String(raw)) as Record<string, unknown>;
          } catch {
            return;
          }
          if (msg['t'] === 'hello') {
            seen = msg;
            try {
              ws.send(JSON.stringify({ t: 'welcome', have: [] }));
            } catch {
              /* peer gone */
            }
          } else if (msg['t'] === 'want') {
            try {
              ws.send(JSON.stringify({ t: 'endbatch' }));
            } catch {
              /* peer gone */
            }
          }
        },
      },
    });
    try {
      const dir = scratch('p2pauth-idhello');
      const res = await syncFromPeer(`ws://127.0.0.1:${server.port}/p2p`, join(dir, 'node'), { timeoutMs: 10000 });
      assert.equal(res.received.length, 0);
      assert.ok(seen && typeof seen['nodeId'] === 'string' && (seen['nodeId'] as string).length > 0, `dialer hello carries nodeId, got ${JSON.stringify(seen)}`);
    } finally {
      server.stop();
    }
  });

  it('resolveNodeId mints distinct identities when none is configured', { timeout: 30_000 }, () => {
    const ids = new Set([resolveNodeId(), resolveNodeId(), resolveNodeId()]);
    assert.equal(ids.size, 3);
    assert.equal(resolveNodeId('  node-1  '), 'node-1');
  });
});
