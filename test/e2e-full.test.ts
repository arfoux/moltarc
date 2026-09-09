// moltarc full lifecycle: hot 5000 mixed rows (multi-device, hash-ref blobs)
// -> seal -> ship -> find 3 -> bitflip -> verify RED -> repair -> verify GREEN
// -> forget (acked only) -> gc sweep -> mergeCold -> status sane.
// Counts asserted every stage: no silent loss, no unacked delete.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { HEADER_SIZE } from '../src/chunk.js';
import { seal } from '../src/seal.js';
import { ship, readRelayIndex } from '../src/ship.js';
import { findTrx } from '../src/find.js';
import { loadManifest } from '../src/manifest.js';
import { sweep, statusInfo } from '../src/gc.js';
import { forgetChunks, mergeCold } from '../src/cold.js';
import { verifyFull, repairAll } from '../src/verify.js';
import { scratch } from './util.js';

const ROWS = 5000;
const TARGET = 8 * 1024;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 60% events text / 25% notes text / 15% photo hash-refs (bytes stay in sidecar).
// Four devices: events+notes share dev-01/dev-02 by seq parity, photo cam-01/cam-02.
function writeMixedHot(dir: string): { hotDb: string; ids: string[]; blobBytes: number } {
  const rnd = mulberry32(7);
  const base = 1_700_000_000_000;
  // Per-table seq 1..N shared across devices (chain needs seq+1 continuity);
  // odd/even split keeps (device_id, seq) unique so dedupe drops nothing.
  const seqByTable: Record<string, number> = { events: 0, notes: 0, photo: 0 };
  const lines: string[] = [];
  const ids: string[] = [];
  let blobBytes = 0;
  for (let i = 0; i < ROWS; i++) {
    const id = `trx-${String(i + 1).padStart(8, '0')}`;
    ids.push(id);
    const slot = rnd();
    if (slot < 0.6) {
      const seq = ++seqByTable.events;
      const dev = seq % 2 ? 'dev-01' : 'dev-02';
      lines.push(JSON.stringify({ device_id: dev, seq, ts: base + i * 1000, id, table: 'events', body: `TRANSACTION OK value=${15000 + (i % 97)} cashier=agus tend=cash change=0 store=jakarta-selatan ref=${((i * 2654435761) >>> 0).toString(16)}` }));
    } else if (slot < 0.85) {
      const seq = ++seqByTable.notes;
      const dev = seq % 2 ? 'dev-02' : 'dev-01';
      lines.push(JSON.stringify({ device_id: dev, seq, ts: base + i * 1000, id, table: 'notes', body: `NOTE seq=${i} stok gudang menipis kirim segera catat manual nota=${((i * 40503) >>> 0).toString(16)}` }));
    } else {
      const seq = ++seqByTable.photo;
      const dev = seq % 2 ? 'cam-01' : 'cam-02';
      const h = createHash('sha256').update(randomBytes(4096)).digest('hex');
      blobBytes += 4096;
      lines.push(JSON.stringify({ device_id: dev, seq, ts: base + i * 1000, id, table: 'photo', body: `blob:sha256:${h}:size=4096` }));
    }
  }
  const hotDb = join(dir, 'hot.jsonl');
  writeFileSync(hotDb, `${lines.join('\n')}\n`);
  return { hotDb, ids, blobBytes };
}

describe('e2e full lifecycle', () => {
  it('seal->ship->find->corrupt->repair->forget->sweep->merge->status with counts', { timeout: 120_000 }, async () => {
    const dir = scratch('e2e-full');
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    const { hotDb, ids } = writeMixedHot(dir);

    // Seal: every hot row lands in exactly one chunk.
    const sealed = await seal({ hotDb, outDir, targetBytes: TARGET });
    assert.equal(sealed.rowsSealed, ROWS, 'all 5000 rows sealed');
    assert.equal(sealed.rowsSkipped, 0, 'nothing silently skipped');
    assert.ok(sealed.chunks.length >= 3, `need >=3 chunks, got ${sealed.chunks.length}`);
    assert.ok(Object.keys(sealed.sealedByDevice).length >= 2, `multi-device watermark, got ${JSON.stringify(sealed.sealedByDevice)}`);
    let { manifest } = loadManifest(outDir);
    assert.equal(manifest.chunks.reduce((n, e) => n + e.rows, 0), ROWS, 'manifest rows match hot rows');
    assert.ok(manifest.chunks.some((e) => e.table === 'photo'), 'blob table sealed as hash refs');
    assert.ok(manifest.chunks.some((e) => e.table === 'events'), 'text table sealed');
    const sealedFiles = manifest.chunks.map((e) => e.file).sort();

    // Ship: text-first lanes carry everything with includeBlobs.
    const shipped = await ship({ outDir, relayDir, includeBlobs: true, baseDelayMs: 1 });
    assert.equal(shipped.sent.length, sealedFiles.length, 'every chunk shipped');
    assert.deepEqual(shipped.skipped, [], 'no lane skipped with includeBlobs');
    assert.equal(Object.keys(readRelayIndex(relayDir).chunks).length, sealedFiles.length, 'relay acks every chunk');
    assert.equal(statusInfo(outDir, relayDir).unacked, 0, 'nothing unacked after ship');

    // Find: first, middle, last ids each resolve to their own row.
    const probes = [ids[0], ids[Math.floor(ids.length / 2)], ids[ids.length - 1]];
    for (const target of probes) {
      const found = findTrx({ outDir, trxId: target });
      assert.equal(found.row.id, target, `find returns ${target}`);
      assert.ok(found.chunksFetched >= 1, 'at least one chunk fetched');
    }

    // Bitflip one text chunk; the walk must go RED on exactly that chunk.
    const victim = manifest.chunks.find((e) => e.table === 'events') ?? manifest.chunks[0];
    const full = join(outDir, 'warm', victim.file);
    const buf = Buffer.from(readFileSync(full));
    buf[HEADER_SIZE + 11] ^= 0x01;
    writeFileSync(full, buf);
    const red = verifyFull(outDir);
    assert.equal(red.ok, false, 'verify RED after bitflip');
    assert.ok(red.bad.includes(victim.file), 'bad list names the flipped chunk');
    assert.equal(red.items.filter((i) => i.status === 'CORRUPT').length, 1, 'exactly one corrupt chunk');

    // Repair by hash from the relay; the walk must go GREEN.
    const repaired = repairAll(outDir, relayDir);
    assert.ok(repaired.repaired.includes(victim.file), 'victim re-fetched from relay');
    assert.deepEqual(repaired.failed, [], 'no repair failure');
    const green = verifyFull(outDir);
    assert.equal(green.ok, true, 'verify GREEN after repair');
    assert.ok(green.items.every((i) => i.status === 'OK'), 'every chunk OK');
    assert.deepEqual(green.chain, [], 'no chain break');

    // Forget one shipped (acked) edge chunk: newest chunk of its table so the
    // per-table hash chain stays contiguous. Rows are accounted, not lost.
    ({ manifest } = loadManifest(outDir));
    const rowsBefore = manifest.chunks.reduce((n, e) => n + e.rows, 0);
    assert.equal(rowsBefore, ROWS, 'repair restored all rows before forget');
    const acked = new Set(Object.keys(readRelayIndex(relayDir).chunks));
    const byTable = new Map<string, typeof manifest.chunks>();
    for (const e of manifest.chunks) byTable.set(e.table, [...(byTable.get(e.table) ?? []), e]);
    let target = manifest.chunks[0];
    for (const list of byTable.values()) {
      list.sort((a, b) => a.seqMin - b.seqMin);
      const edge = list[list.length - 1];
      if (!probes.some((id) => edge.minKey <= id && id <= edge.maxKey) && acked.has(edge.sha256)) { target = edge; break; }
      if (acked.has(edge.sha256)) target = edge;
    }
    assert.ok(acked.has(target.sha256), 'forget target is relay-acked (no unacked delete)');
    const rowsForgotten = target.rows;
    // No silent unacked delete: empty relayDir refuses, and unshipped data refuses.
    assert.throws(() => forgetChunks(outDir, [target.file], ''), /relayDir/, 'forget without relay refuses');
    const forgot = forgetChunks(outDir, [target.file], relayDir);
    assert.deepEqual(forgot.removed, [target.file], 'exactly the target forgotten');
    ({ manifest } = loadManifest(outDir));
    assert.equal(manifest.chunks.length, sealedFiles.length - 1, 'manifest shrinks by one');
    assert.equal(manifest.chunks.reduce((n, e) => n + e.rows, 0), ROWS - rowsForgotten, 'forgotten rows accounted');
    assert.ok(acked.has(target.sha256), 'forgotten bytes stay acked in the relay');

    // GC sweep: the forgotten warm file is the one orphan; apply removes only it.
    const dry = sweep(outDir, { relayDir });
    assert.equal(dry.dryRun, true, 'dry-run by default');
    assert.ok(dry.orphans.includes(target.file), 'forgotten file shows as orphan');
    assert.ok(existsSync(join(outDir, 'warm', target.file)), 'dry-run deletes nothing');
    const applied = sweep(outDir, { dryRun: false, relayDir });
    assert.deepEqual(applied.removed, [target.file], 'sweep removes exactly the forgotten orphan');
    assert.deepEqual(applied.skippedUnacked, [], 'nothing unacked retained');
    assert.ok(applied.bytesReclaimed > 0, 'bytes reclaimed');
    for (const e of manifest.chunks) assert.ok(existsSync(join(outDir, 'warm', e.file)), `live chunk kept: ${e.file}`);

    // MergeCold: remaining warm packs into one cold segment; live rows survive.
    const merged = mergeCold(outDir);
    assert.ok(merged.segment.endsWith('.tar'), 'cold segment written');
    assert.equal(merged.chunks.length, manifest.chunks.length, 'every live chunk merged');
    assert.ok(merged.bytes > 0, 'segment non-empty');
    for (const targetId of probes) {
      const found = findTrx({ outDir, trxId: targetId });
      assert.equal(found.row.id, targetId, `live row ${targetId} survives forget+sweep+merge`);
    }

    // Status sane: manifest/warm/cold agree, nothing unacked, no orphans.
    const st = statusInfo(outDir, relayDir);
    assert.equal(st.chunks, manifest.chunks.length, 'status counts live manifest chunks');
    assert.equal(st.unacked, 0, 'nothing unacked at the end');
    assert.equal(st.orphans, 0, 'no orphans after sweep');
    assert.equal(st.warmChunks, manifest.chunks.length, 'all live chunks present in warm');
    assert.ok(st.coldSegments >= 1, 'cold segment listed');
    assert.equal(st.coldChunks, manifest.chunks.length, 'cold covers every live chunk');
    console.log(`e2e-full: rows=${ROWS} chunks=${sealedFiles.length} forgot=${target.file} rows=${rowsForgotten} seg=${merged.segment} bytes=${merged.bytes}`);
  });
});
