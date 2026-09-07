// lossfix regressions: per-device seal watermark (no silent multi-device
// loss) and relay-ack guard on forget/gc (no silent unacked delete).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { forgetChunks } from '../src/cold.js';
import { sweep } from '../src/gc.js';
import { loadManifest } from '../src/manifest.js';
import { findTrx } from '../src/find.js';
import { verifyFull } from '../src/verify.js';
import { scratch, writeHotLog } from './util.js';

function hotLine(device: string, seq: number, id: string): string {
  return JSON.stringify({
    device_id: device, seq, ts: 1_700_000_000_000 + seq,
    id, table: 'sales', body: `bayar nominal=${seq * 1000} kasir=${device} ref=${id}`,
  });
}

describe('per-device seal watermark', () => {
  it('sealing kasir-01 seq1-5 never skips kasir-02 seq1-3', { timeout: 30_000 }, async () => {
    const dir = scratch('lossfix-twodevice');
    mkdirSync(dir, { recursive: true });
    const hotDb = join(dir, 'hot.jsonl');
    const outDir = join(dir, 'archive');
    const lines: string[] = [];
    for (let s = 1; s <= 5; s++) lines.push(hotLine('kasir-01', s, `k1-${s}`));
    writeFileSync(hotDb, `${lines.join('\n')}\n`);

    const first = await seal({ hotDb, outDir });
    assert.equal(first.rowsSealed, 5);
    assert.deepEqual(first.sealedByDevice, { 'kasir-01': 5 });

    for (let s = 1; s <= 3; s++) lines.push(hotLine('kasir-02', s, `k2-${s}`));
    writeFileSync(hotDb, `${lines.join('\n')}\n`);

    const second = await seal({ hotDb, outDir });
    assert.equal(second.rowsSealed, 3);
    assert.equal(second.rowsSkipped, 5);
    assert.deepEqual(second.sealedByDevice, { 'kasir-01': 5, 'kasir-02': 3 });

    const found = findTrx({ outDir, trxId: 'k2-2' });
    assert.equal(found.row.id, 'k2-2');

    const third = await seal({ hotDb, outDir });
    assert.equal(third.rowsSealed, 0);
    assert.equal(third.rowsSkipped, 8);
  });
});

describe('relay-ack guard on forget and gc', () => {
  it('forgetting the only unshipped chunk is refused and gc keeps it', { timeout: 30_000 }, async () => {
    const dir = scratch('lossfix-unacked');
    const { hotDb } = writeHotLog(dir, { rows: 200 });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay'); // never shipped: no relay index yet
    const sealed = await seal({ hotDb, outDir });
    assert.equal(sealed.chunks.length, 1);
    const only = sealed.chunks[0].split(/[\\/]/).pop() as string;

    assert.throws(() => forgetChunks(outDir, [only], relayDir), /unacked/);
    assert.ok(loadManifest(outDir).manifest.chunks.some((e) => e.file === only), 'refused forget keeps the manifest entry');
    assert.ok(existsSync(join(outDir, 'warm', only)), 'refused forget keeps the warm bytes');
    assert.ok(verifyFull(outDir).ok, 'nothing lost: full walk still clean');

    const kept = sweep(outDir, { dryRun: false, relayDir });
    assert.ok(!kept.removed.includes(only), 'gc keeps the live unshipped chunk');
    assert.ok(existsSync(join(outDir, 'warm', only)));

    const orphan = 'sales-000001-000001-deadbeef.chk';
    writeFileSync(join(outDir, 'warm', orphan), Buffer.from('orphan-bytes'));
    const held = sweep(outDir, { dryRun: false, relayDir });
    assert.ok(held.orphans.includes(orphan));
    assert.deepEqual(held.skippedUnacked, [orphan]);
    assert.ok(!held.removed.includes(orphan), 'gc never deletes unshipped warm files');
    assert.ok(existsSync(join(outDir, 'warm', orphan)));

    await ship({ outDir, relayDir, baseDelayMs: 1 });
    const pruned = forgetChunks(outDir, [only], relayDir);
    assert.deepEqual(pruned.removed, [only]);
    const collected = sweep(outDir, { dryRun: false, relayDir });
    assert.ok(collected.removed.includes(only), 'acked orphans still collect');
    assert.ok(collected.skippedUnacked.includes(orphan), 'unacked garbage stays');
  });

  it('acked middle forget still shows as a verifyFull chain gap', { timeout: 30_000 }, async () => {
    const dir = scratch('lossfix-chain');
    const { hotDb } = writeHotLog(dir, { rows: 4000, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    const sealed = await seal({ hotDb, outDir, targetBytes: 8 * 1024 });
    assert.ok(sealed.chunks.length >= 3, `need >=3 chunks, got ${sealed.chunks.length}`);
    await ship({ outDir, relayDir, baseDelayMs: 1 });
    const files = sealed.chunks.map((c) => c.split(/[\\/]/).pop() as string);
    const middle = [...files].sort()[1];
    forgetChunks(outDir, [middle], relayDir);

    const v = verifyFull(outDir);
    assert.equal(v.chain.length, 0);
    assert.equal(v.chainGaps.length, 1);
    assert.ok(v.ok);
  });
});
