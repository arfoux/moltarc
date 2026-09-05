// cold restore-from-cold-only drill: seal+ship+mergeCold, then total loss
// except cold tars (hot + warm + dicts + manifest copies + sidecars + relay
// all deleted), then rebuild the manifest from the tars alone, find 3 known
// ids, verify the chain, and prove byte-equality of every restored row.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { decodeChunk, decodeHeader, DICT_FLAG } from '../src/chunk.js';
import { loadDictFor } from '../src/dict.js';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { mergeCold, readTar } from '../src/cold.js';
import { clearFindCaches, findTrx } from '../src/find.js';
import { buildManifest, loadManifest, saveManifestAtomic } from '../src/manifest.js';
import { verifyFull } from '../src/verify.js';
import { scratch, writeHotLog } from './util.js';
function snapshotRows(outDir: string): Map<string, string> {
  const snap = new Map<string, string>();
  const warm = join(outDir, 'warm');
  const dictDir = join(outDir, 'dicts');
  for (const f of readdirSync(warm).filter((x) => x.endsWith('.chk')).sort()) {
    const buf = readFileSync(join(warm, f));
    const header = decodeHeader(buf);
    const dict = (header.flags & DICT_FLAG) !== 0 ? loadDictFor(dictDir, header.dictId) ?? undefined : undefined;
    const { rows } = decodeChunk(buf, dict);
    for (const r of rows) snap.set(r.id, JSON.stringify(r));
  }
  return snap;
}

function digestRows(snap: Map<string, string>): string {
  const h = createHash('sha256');
  for (const k of [...snap.keys()].sort()) h.update(k).update('\0').update(snap.get(k)!).update('\0');
  return h.digest('hex');
}

// Restore helper: cold tars are the only input. dict members land back in
// dicts/ first (dict-flagged chunks decode only with them), chunk members in
// warm/, then the manifest rebuilds from disk and reattaches the cold listing
// scanned from the segments themselves (no manifest/relay/hot to salvage).
function restoreFromColdOnly(outDir: string): string[] {
  const coldDir = join(outDir, 'cold');
  const segs = readdirSync(coldDir).filter((f) => f.endsWith('.tar')).sort();
  assert.ok(segs.length > 0, 'cold dir must hold at least one tar to restore from');
  const warm = join(outDir, 'warm');
  const dicts = join(outDir, 'dicts');
  mkdirSync(warm, { recursive: true });
  mkdirSync(dicts, { recursive: true });
  const cold: { file: string; chunks: string[]; bytes: number }[] = [];
  for (const seg of segs) {
    const full = join(coldDir, seg);
    const members = readTar(readFileSync(full));
    const chunks: string[] = [];
    for (const m of members) {
      if (m.name.startsWith('dicts/')) {
        writeFileSync(join(outDir, m.name), Buffer.from(m.data));
      } else {
        writeFileSync(join(warm, m.name), Buffer.from(m.data));
        chunks.push(m.name);
      }
    }
    chunks.sort();
    cold.push({ file: seg, chunks, bytes: statSync(full).size });
  }
  cold.sort((a, b) => (a.file < b.file ? -1 : 1));
  const manifest = buildManifest(outDir);
  manifest.cold = cold;
  saveManifestAtomic(outDir, manifest);
  clearFindCaches();
  return segs;
}

describe('cold restore from cold only', () => {
  it('rebuilds manifest from tars, finds 3 ids, verifies chain, byte-matches rows', { timeout: 120_000 }, async () => {
    const dir = scratch('cold-restore');
    const { hotDb, ids } = writeHotLog(dir, { rows: 3000, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');

    // (1) build the archive: seal + ship + merge into cold.
    await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
    await ship({ outDir, relayDir, baseDelayMs: 1 });
    const merged = mergeCold(outDir);
    assert.ok(merged.segment.endsWith('.tar'), 'merge packs one cold segment');
    assert.ok(merged.chunks.length >= 2, 'fixture spans several chunks');
    clearFindCaches();

    // pre-delete snapshot: every row canonicalized + 3 known ids resolved.
    const before = snapshotRows(outDir);
    assert.ok(before.size >= 3000, `snapshot holds all rows, got ${before.size}`);
    const beforeDigest = digestRows(before);
    const targets = [ids[0], ids[Math.floor(ids.length / 2)], ids[ids.length - 1]];
    const expectRows = targets.map((id) => JSON.stringify(findTrx({ outDir, trxId: id }).row));

    // (2) total loss except cold tars: hot + warm + dicts + every manifest
    // copy/sidecar + watermark + relay dir all deleted.
    rmSync(hotDb, { force: true });
    rmSync(join(outDir, 'warm'), { recursive: true, force: true });
    rmSync(join(outDir, 'dicts'), { recursive: true, force: true });
    for (const f of readdirSync(outDir)) {
      if (f === 'manifest.json' || f === 'manifest.bak.json' || f === 'sparse.json' || f === 'sparse.bak.json' || /^manifest-\d{4}-\d{2}\.json$/.test(f)) {
        rmSync(join(outDir, f), { force: true });
      }
    }
    rmSync(join(outDir, 'sealed_upto_seq'), { force: true });
    rmSync(relayDir, { recursive: true, force: true });
    clearFindCaches();

    // cold-only precondition: none of hot/manifest/relay/warm may exist now.
    assert.ok(!existsSync(hotDb), 'hot deleted');
    assert.ok(!existsSync(join(outDir, 'warm')), 'warm deleted');
    assert.ok(!existsSync(join(outDir, 'manifest.json')), 'manifest deleted');
    assert.ok(!existsSync(join(outDir, 'manifest.bak.json')), 'manifest backup deleted');
    assert.ok(!existsSync(relayDir), 'relay deleted');
    assert.ok(existsSync(join(outDir, 'cold', merged.segment)), 'cold tar survives');

    // (3) restore from the tars alone.
    const segs = restoreFromColdOnly(outDir);
    assert.ok(segs.includes(merged.segment), 'restored segment listing covers the packed tar');
    const { manifest, source } = loadManifest(outDir);
    assert.equal(source, 'primary', 'rebuilt manifest saved as primary');
    assert.equal(manifest.chunks.length, merged.chunks.length, 'chunk count matches the merge');
    assert.ok((manifest.cold ?? []).some((s) => s.file === merged.segment), 'cold listing reattached from tars');

    // find the 3 known ids through the rebuilt index.
    for (let i = 0; i < targets.length; i++) {
      const found = findTrx({ outDir, trxId: targets[i] });
      assert.equal(found.row.id, targets[i], `target ${i} resolves`);
      assert.equal(JSON.stringify(found.row), expectRows[i], `target ${i} byte-matches`);
    }

    // verify the chain end to end.
    const full = verifyFull(outDir);
    assert.deepEqual(full.chain, [], 'no chain breaks after restore');
    assert.deepEqual(full.bad, [], 'no bad chunks after restore');
    assert.equal(full.ok, true, 'verifyFull green after restore');

    // byte-equality of every restored row vs the pre-delete snapshot.
    const after = snapshotRows(outDir);
    assert.equal(after.size, before.size, 'row count matches snapshot');
    assert.equal(digestRows(after), beforeDigest, 'row digest matches snapshot');
    for (const [id, json] of before) assert.equal(after.get(id), json, `row ${id} byte-matches`);
  });
});
