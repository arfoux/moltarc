// p2p tunnel CIDR gate: FAIL pre-fix (no such options), PASS post-fix.
// Opt-in, fail-closed: off-subnet peers rejected with a loud error; default OFF.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { ipInTunnelCidrs, normTunnelIp, startNode, syncFromPeer, tunnelCidrValid } from '../src/p2p.js';
import { scratch, writeHotLog } from './util.js';

describe('p2p tunnel CIDR gate', () => {
  it('matcher is fail-closed on bad CIDR, unknown IP, and off-subnet peers', { timeout: 30_000 }, () => {
    assert.equal(ipInTunnelCidrs('10.44.0.2', '10.44.0.0/24'), true);
    assert.equal(ipInTunnelCidrs('::ffff:10.44.0.2', '10.44.0.0/24'), true);
    assert.equal(ipInTunnelCidrs('10.44.1.2', '10.44.0.0/24'), false);
    assert.equal(ipInTunnelCidrs('not-an-ip', '10.44.0.0/24'), false);
    assert.equal(ipInTunnelCidrs('10.44.0.2', 'bogus'), false);
    assert.equal(ipInTunnelCidrs('192.168.5.9', ['10.0.0.0/8', '192.168.5.0/24']), true);
    assert.equal(ipInTunnelCidrs('11.0.0.1', ['10.0.0.0/8', '192.168.5.0/24']), false);
    assert.equal(normTunnelIp('::ffff:10.44.0.2'), '10.44.0.2');
    assert.equal(tunnelCidrValid('10.44.0.0/24'), true);
    assert.equal(tunnelCidrValid('bogus'), false);
    assert.equal(tunnelCidrValid(undefined), true);
  });

  it('server with a tunnel subnet refuses off-subnet peers but serves on-subnet ones', { timeout: 60_000 }, async () => {
    const dir = scratch('p2ptunnel-srv');
    const { hotDb } = writeHotLog(dir, { rows: 300, uniqueBodies: true });
    const aDir = join(dir, 'node-a');
    const bDir = join(dir, 'node-b');
    const r = await seal({ hotDb, outDir: aDir, targetBytes: 16 * 1024 });
    assert.ok(r.chunks.length >= 1);
    // Localhost dials land as 127.0.0.1: a 10.44/24 gate must refuse them loud.
    const gated = startNode({ outDir: aDir, port: 0, allowedPeersCIDR: '10.44.0.0/24' });
    try {
      await assert.rejects(
        syncFromPeer(gated.url, bDir, { blockBytes: 1024, timeoutMs: 8000 }),
        /outside allowed tunnel subnet|connection lost|timeout/,
        'off-subnet peer refused when gate on',
      );
      // requireTunnelCIDR is the same gate under the alias spelling.
      assert.throws(
        () => startNode({ outDir: join(dir, 'bad'), port: 0, requireTunnelCIDR: 'bogus' }),
        /allowedPeersCIDR invalid/,
        'bad CIDR fails loud at startNode, never silently open',
      );
    } finally {
      gated.stop();
    }
    // Same nodes, no gate: legacy behavior unchanged.
    const open = startNode({ outDir: aDir, port: 0 });
    try {
      const ok = await syncFromPeer(open.url, bDir, { blockBytes: 1024, timeoutMs: 15000 });
      assert.ok(ok.received.length >= 1, 'no gate = old behavior');
    } finally {
      open.stop();
    }
    // On-subnet gate (localhost inside 127/8) serves fine.
    const local = startNode({ outDir: aDir, port: 0, allowedPeersCIDR: '127.0.0.0/8' });
    try {
      const ok = await syncFromPeer(local.url, join(dir, 'node-c'), { blockBytes: 1024, timeoutMs: 15000 });
      assert.ok(ok.received.length >= 1, 'on-subnet peer served');
    } finally {
      local.stop();
    }
  });

  it('dial gate refuses off-subnet URLs before any byte moves', { timeout: 30_000 }, async () => {
    const dir = scratch('p2ptunnel-dial');
    const bDir = join(dir, 'node-b');
    await assert.rejects(
      syncFromPeer('ws://10.44.9.9:4171/p2p', bDir, { allowedPeersCIDR: '10.44.0.0/24', timeoutMs: 4000 }),
      /dial refused.*outside allowed tunnel subnet/,
      'off-subnet dial rejected pre-connect',
    );
    await assert.rejects(
      syncFromPeer('ws://127.0.0.1:1/p2p', bDir, { allowedPeersCIDR: 'bogus', timeoutMs: 4000 }),
      /allowedPeersCIDR invalid/,
      'bad dial CIDR fails loud, never dials',
    );
  });
});
