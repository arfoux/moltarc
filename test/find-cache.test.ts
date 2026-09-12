// find-cache regressions: stat-alias stale window + dead sparseCache.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { findTrx, clearFindCaches } from '../src/find.js';
import { manifestCrc, shardCrc, sparseCrc } from '../src/manifest.js';
import { scratch, writeHotLog } from './util.js';

function sameStatRewrite(path: string, makeBody: (orig: string) => string): void {
  const st = statSync(path);
  const orig = readFileSync(path, 'utf8');
  const next = makeBody(orig);
  assert.equal(
    Buffer.byteLength(next), Buffer.byteLength(orig),
    `forged ${path} must keep byte size`,
  );
  writeFileSync(path, next);
  utimesSync(path, st.atime, st.mtime);
}
// Whole-second pin: mtimes carry sub-ms fractions that Date round-trips
// lossily, so pin files to an exact time BEFORE the first (cache-filling)
// find; the forge then restores a stat the cache really holds.
const PIN = new Date(1_700_000_000_000);
function pinMtime(path: string): void {
  try { utimesSync(path, PIN, PIN); } catch { /* absent sidecar */ }
}

describe('find cache freshness', () => {
  it('manifest rewrite with same mtime+size but new seq is not stale', { timeout: 60_000 }, async () => {
    const dir = scratch('find-cache-manifest');
    const { hotDb, ids } = writeHotLog(dir, { rows: 3000, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    const r = await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
    assert.ok(r.chunks.length >= 2, `need >=2 chunks, got ${r.chunks.length}`);
    clearFindCaches();

    pinMtime(join(outDir, 'manifest.json'));
    pinMtime(join(outDir, 'manifest.bak.json'));
    pinMtime(join(outDir, 'sparse.json'));
    const target = ids[Math.floor(ids.length * 0.7)];
    const found = findTrx({ outDir, trxId: target });
    assert.equal(found.row.id, target);
    // Drop the chunk holding target; bump seq + fix crc so the copy stays valid.
    const dropFile = found.chunk;
    const forge = (p: string) =>
      sameStatRewrite(p, (orig) => {
        const m = JSON.parse(orig);
        m.chunks = m.chunks.filter((c: { file: string }) => c.file !== dropFile);
        m.seq = (typeof m.seq === 'number' ? m.seq : 0) + 50;
        m.crc32c = manifestCrc(m);
        const body = JSON.stringify(m);
        const pad = Buffer.byteLength(orig, 'utf8') - Buffer.byteLength(body, 'utf8') - 1;
        assert.ok(pad >= 0, 'forged manifest must fit in original size');
        return `${body}${' '.repeat(pad)}\n`;
      });
    forge(join(outDir, 'manifest.json'));
    try { forge(join(outDir, 'manifest.bak.json')); } catch { /* single copy archive */ }
    // A real reseal bumps seq on every sidecar consistently. Forge sparse +
    // shards to the same new seq and drop the target there too; otherwise the
    // shard fast-path (sparse → shard → chunk file, still on disk) legitimately
    // keeps finding the row while the root manifest alone says it is gone.
    const newSeq = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')).seq;
    const forgeSparse = (p: string) =>
      sameStatRewrite(p, (orig) => {
        const s = JSON.parse(orig);
        s.entries = s.entries.filter((e: { file: string }) => e.file !== dropFile);
        s.total = s.entries.length;
        s.seq = newSeq;
        s.crc32c = sparseCrc(s);
        const body = JSON.stringify(s);
        const pad = Buffer.byteLength(orig, 'utf8') - Buffer.byteLength(body, 'utf8') - 1;
        assert.ok(pad >= 0, 'forged sparse must fit in original size');
        return `${body}${' '.repeat(pad)}\n`;
      });
    forgeSparse(join(outDir, 'sparse.json'));
    for (const f of readdirSync(outDir).filter((f: string) => /^manifest-\d{4}-\d{2}\.json$/.test(f))) {
      sameStatRewrite(join(outDir, f), (orig) => {
        const s = JSON.parse(orig);
        s.chunks = s.chunks.filter((c: { file: string }) => c.file !== dropFile);
        s.seq = newSeq;
        s.crc32c = shardCrc(s);
        const body = JSON.stringify(s);
        const pad = Buffer.byteLength(orig, 'utf8') - Buffer.byteLength(body, 'utf8') - 1;
        assert.ok(pad >= 0, `forged ${f} must fit in original size`);
        return `${body}${' '.repeat(pad)}\n`;
      });
    }
    assert.throws(() => findTrx({ outDir, trxId: target }), /not found/);
    clearFindCaches();
  });

  it('sparse cache hits memory on second find without re-parse', { timeout: 60_000 }, async () => {
    const dir = scratch('find-cache-sparse');
    const { hotDb, ids } = writeHotLog(dir, { rows: 3000, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    const r = await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
    assert.ok(r.chunks.length >= 2, `need >=2 chunks, got ${r.chunks.length}`);
    clearFindCaches();
    pinMtime(join(outDir, 'sparse.json'));

    const target = ids[Math.floor(ids.length * 0.7)];
    const first = findTrx({ outDir, trxId: target });
    assert.equal(first.row.id, target);

    // Forge sparse.json on disk WITHOUT touching stat or seq: drop the target
    // row, fix crc, pad to the same bytes. A live memory cache still finds the
    // row; a dead cache re-parses and reports not found.
    sameStatRewrite(join(outDir, 'sparse.json'), (orig) => {
      const s = JSON.parse(orig);
      s.entries = s.entries.filter((e: { file: string }) => e.file !== first.chunk);
      s.total = s.entries.length;
      s.crc32c = sparseCrc(s);
      const body = JSON.stringify(s);
      const pad = Buffer.byteLength(orig, 'utf8') - Buffer.byteLength(body, 'utf8') - 1;
      assert.ok(pad >= 0, 'forged sparse must fit in original size');
      return `${body}${' '.repeat(pad)}\n`;
    });

    const second = findTrx({ outDir, trxId: target });
    assert.equal(second.row.id, target);
    clearFindCaches();
  });
});
