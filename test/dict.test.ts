// Dictionary compat: old flagless chunks decode with any dict_id;
// trained dict chunks need their dict file, with a clear error otherwise;
// unique tables train nothing.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { decodeChunk, decodeHeader, compressFrame, decompressFrame, encodeHeader, crc32c, HEADER_SIZE } from '../src/chunk.js';
import { trainTableDict, loadDictFor } from '../src/dict.js';
import { seal } from '../src/seal.js';
import { findTrx } from '../src/find.js';
import { loadManifest } from '../src/manifest.js';
import { scratch, writeHotLog } from './util.js';

import { mulberry32 } from '../bench/mixed-corpus.js';

function highEntropy(n: number): string[] {
  const rnd = mulberry32(99);
  return Array.from({ length: n }, (_, i) => {
    let s = `n${i}-`;
    for (let k = 0; k < 16; k++) s += Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, '0');
    return s;
  });
}

describe('per-store dictionary', () => {
  it('trains on repetitive tables, skips unique ones', async () => {
    const dir = scratch('dict');
    const bodies = highEntropy(500);
    assert.equal(trainTableDict(bodies), null);
    // A sealed high-entropy table trains nothing and stores no dict file.
    const lines = bodies.map((body, i) => JSON.stringify({ device_id: 'dev0', seq: i + 1, ts: i, id: `id-${i}`, table: 'rand', body }));
    const hotDb = join(dir, 'hot.jsonl');
    writeFileSync(hotDb, `${lines.join('\n')}\n`);
    await seal({ hotDb, outDir: join(dir, 'archive') });
    assert.ok(!existsSync(join(dir, 'archive', 'dicts')));
  });

  it('repetitive seal trains a dict file and chunks need it', async () => {
    const dir = scratch('dict-rep');
    const { hotDb, ids } = writeHotLog(dir, { rows: 2000 });
    const outDir = join(dir, 'archive');
    const r = await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
    const dicts = existsSync(join(outDir, 'dicts')) ? readdirSync(join(outDir, 'dicts')) : [];
    assert.ok(dicts.length >= 1, 'trained dict file saved');
    assert.ok(dicts.every((f: string) => f.endsWith('.dict')));

    // Normal path resolves the dict and finds rows.
    const target = ids[1000];
    const found = findTrx({ outDir, trxId: target });
    assert.equal(found.row.id, target);
    void r;
  });

  it('pre-dict chunks (flagless, any dict_id) still decode', async () => {
    const dir = scratch('dict-old');
    const { hotDb, ids } = writeHotLog(dir, { rows: 300 });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir });
    const warm = readdirSync(join(outDir, 'warm')).filter((f: string) => f.endsWith('.chk'));
    const buf = Buffer.from(readFileSync(join(outDir, 'warm', warm[0])));
    // Faithful pre-dict chunk: plain-compressed body, flag cleared, dict_id scribbled.
    const header = decodeHeader(buf);
    const dict = (header.flags & 0x02) !== 0 ? loadDictFor(join(outDir, 'dicts'), header.dictId) ?? undefined : undefined;
    const raw = decompressFrame(header.codec, Buffer.from(buf.subarray(HEADER_SIZE)), dict);
    const plain = compressFrame(raw);
    assert.equal(plain.usedDict, false);
    const old = Buffer.concat([
      encodeHeader({ ...header, codec: plain.codec, flags: header.flags & ~0x02, dictId: 0xdeadbeef, bodyLen: plain.body.length, crc32c: crc32c(plain.body) }),
      plain.body,
    ]);
    const { rows } = decodeChunk(old);
    assert.ok(rows.length > 0);
    assert.equal(rows[0].id, ids[0]);
  });

  it('dict chunk without its dict file fails with a clear error', async () => {
    const dir = scratch('dict-missing');
    const { hotDb } = writeHotLog(dir, { rows: 2000 });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
    const entries = loadManifest(outDir).manifest.chunks.filter((e) => !e.quarantined);
    const flagged = entries.find((e) => {
      const h = decodeHeader(readFileSync(join(outDir, 'warm', e.file)));
      return (h.flags & 0x02) !== 0;
    });
    assert.ok(flagged, 'expected at least one dict-flagged chunk');
    const raw = readFileSync(join(outDir, 'warm', flagged.file));
    assert.throws(() => decodeChunk(Buffer.from(raw)), /chunk needs dict/);
  });
});
