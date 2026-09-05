// Fault injection: bitflip survival, manifest truncation fallback, deleted-dictionary loud error.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { HEADER_SIZE, decodeHeader, decompressFrame, compressFrame, encodeHeader, crc32c, DICT_FLAG } from '../src/chunk.js';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { findTrx } from '../src/find.js';
import { loadManifest } from '../src/manifest.js';
import { loadDictFor } from '../src/dict.js';
import { verifyAll, quarantine, repairByHash } from '../src/verify.js';
import { scratch, writeHotLog } from './util.js';

describe('fault injection', () => {
  it('1 flipped bit: other chunks stay queryable, then quarantine + repair-by-hash', { timeout: 30_000 }, async () => {
    const dir = scratch('fault-bit');
    const { hotDb } = writeHotLog(dir, { rows: 4000, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    const sealed = await seal({ hotDb, outDir, targetBytes: 8 * 1024 });
    assert.ok(sealed.chunks.length >= 3, `need >=3 chunks, got ${sealed.chunks.length}`);
    await ship({ outDir, relayDir, baseDelayMs: 1 });

    const victim = sealed.chunks[1];
    const buf = Buffer.from(readFileSync(victim));
    buf[HEADER_SIZE + 11] ^= 0x01; // single bit, middle of the compressed body
    writeFileSync(victim, buf);

    const v = verifyAll(outDir);
    assert.equal(v.bad.length, 1);
    assert.equal(v.bad[0], victim.split(/[\\/]/).pop());

    // Other chunks stay queryable while the bad one is still in place.
    const lastEntry = loadManifest(outDir).manifest.chunks
      .filter((e) => e.file !== v.bad[0])
      .sort((a, b) => a.seqMax - b.seqMax)
      .pop() as { maxKey: string };
    const found = findTrx({ outDir, trxId: lastEntry.maxKey });
    assert.equal(found.row.id, lastEntry.maxKey);

    quarantine(outDir, v.bad[0]);
    repairByHash(outDir, relayDir, v.bad[0]);
    const after = verifyAll(outDir);
    assert.ok(after.ok);
    assert.equal(after.bad.length, 0);
  });

  it('manifest cut mid-write falls back to .bak, then to filename rebuild', { timeout: 30_000 }, async () => {
    const dir = scratch('fault-manifest');
    const { hotDb } = writeHotLog(dir, { rows: 500, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    const sealed = await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
    const full = readFileSync(join(outDir, 'manifest.json'));
    const half = full.subarray(0, Math.floor(full.length / 2));

    writeFileSync(join(outDir, 'manifest.json'), half);
    const viaBackup = loadManifest(outDir);
    assert.equal(viaBackup.source, 'backup');
    assert.equal(viaBackup.manifest.chunks.length, sealed.chunks.length);

    writeFileSync(join(outDir, 'manifest.json'), half);
    writeFileSync(join(outDir, 'manifest.bak.json'), half);
    const rebuilt = loadManifest(outDir);
    assert.equal(rebuilt.source, 'rebuilt');
    assert.equal(rebuilt.manifest.chunks.length, sealed.chunks.length);
  });

  it('deleted body dictionary throws a clear error, never silent rows', { timeout: 30_000 }, async () => {
    const dir = scratch('fault-dict');
    const { hotDb } = writeHotLog(dir, { rows: 1200, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    const sealed = await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
    assert.ok(sealed.chunks.length >= 1);
    const victim = sealed.chunks[0];
    const victimName = victim.split(/[\\/]/).pop() as string;
    const targetId = loadManifest(outDir).manifest.chunks.find((e) => e.file === victimName)?.minKey as string;

    // Delete the dictionary, then re-seal the header flagless with valid crc:
    // decode must fail loud on the missing pool.
    const buf = Buffer.from(readFileSync(victim));
    const header = decodeHeader(buf);
    const trained = (header.flags & DICT_FLAG) !== 0
      ? loadDictFor(join(outDir, 'dicts'), header.dictId) ?? undefined
      : undefined;
    const frame = JSON.parse(decompressFrame(header.codec, Buffer.from(buf.subarray(HEADER_SIZE)), trained).toString()) as { pool: string[] };
    frame.pool = [];
    const raw = Buffer.from(JSON.stringify(frame), 'utf8');
    const packed = compressFrame(raw);
    const fresh = Buffer.concat([
      encodeHeader({ ...header, codec: packed.codec, flags: header.flags & ~DICT_FLAG, bodyLen: packed.body.length, crc32c: crc32c(packed.body) }),
      packed.body,
    ]);
    writeFileSync(victim, fresh);

    assert.throws(() => findTrx({ outDir, trxId: targetId }), /frame corrupt: body dictionary deleted/);
  });
});
