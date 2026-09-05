// mergecold streaming: byte-identical tar output with bounded ram.
// Small fixture proves the streamed segment matches the buffer-built oracle
// byte for byte (headers, order, padding, end marker, manifest). Large
// fixture proves peak extra rss stays flat while input scales past 100mb.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mergeCold, readTar, writeTar } from '../src/cold.js';
import { loadManifest, saveManifestAtomic } from '../src/manifest.js';
import type { ChunkEntry } from '../src/manifest.js';
import { HEADER_SIZE, crc32c, DICT_FLAG, encodeHeader } from '../src/chunk.js';
import { dictHex } from '../src/dict.js';
import { scratch } from './util.js';

// Bun.gc exists under bun test, absent elsewhere.
const bunRuntime = globalThis as unknown as { Bun?: { gc(force: boolean): void } };

function lcgFill(buf: Buffer, seed: number): void {
  let s = seed >>> 0;
  for (let i = 0; i < buf.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    buf[i] = (s >>> 24) & 0xff;
  }
}

function entry(name: string, bytes: number, dictId: number): ChunkEntry {
  return {
    file: name, table: 't', seqMin: 0, seqMax: 0, tsMin: 0, tsMax: 0, rows: 1,
    bytes, sha256: '', crc32c: 0, dictId, codec: 0, minKey: '', maxKey: '', bloom: '',
  };
}

// Valid chunk bytes (header + deterministic body), or raw bytes when size
// cannot fit a header (empty / torn members merge verbatim like before).
function chunkBytes(size: number, seed: number, dictId: number): Buffer {
  if (size < HEADER_SIZE) {
    const raw = Buffer.alloc(size);
    lcgFill(raw, seed);
    return raw;
  }
  const body = Buffer.alloc(size - HEADER_SIZE);
  lcgFill(body, seed);
  const head = encodeHeader({
    ver: 1, codec: 0, flags: dictId !== 0 ? DICT_FLAG : 0, tableId: 7,
    seqMin: BigInt(seed), seqMax: BigInt(seed), tsMin: 0n, tsMax: 0n,
    rows: 1, crc32c: crc32c(body), dictId, bodyLen: body.length,
  });
  return Buffer.concat([head, body]);
}

describe('mergecold streaming', () => {
  it('streams byte-identical tar, order, padding, and manifest as the buffered build', { timeout: 30_000 }, () => {
    const dir = scratch('mergestream-ident');
    const outDir = join(dir, 'archive');
    mkdirSync(join(outDir, 'warm'), { recursive: true });
    // Odd sizes hit every padding edge (0, torn, 511/512/513) plus a
    // dict-flagged chunk whose dictionary must ride along in the same tar.
    const dictId = 0x8f3c2a11;
    const plan: { name: string; size: number; dict: number }[] = [
      { name: 'c-003.chk', size: 513, dict: 0 },
      { name: 'c-001.chk', size: 512, dict: 0 },
      { name: 'c-005.chk', size: 70_000, dict: dictId },
      { name: 'c-000.chk', size: 0, dict: 0 },
      { name: 'c-004.chk', size: 10, dict: 0 },
      { name: 'c-002.chk', size: 511, dict: 0 },
    ];
    const byName = new Map<string, Buffer>();
    plan.forEach((p, i) => {
      const bytes = chunkBytes(p.size, 1000 + i, p.dict);
      writeFileSync(join(outDir, 'warm', p.name), bytes);
      byName.set(p.name, bytes);
    });
    const dictName = `dict-${dictHex(dictId)}.dict`;
    const dictBytes = Buffer.alloc(1000);
    lcgFill(dictBytes, 42);
    mkdirSync(join(outDir, 'dicts'), { recursive: true });
    writeFileSync(join(outDir, 'dicts', dictName), dictBytes);
    saveManifestAtomic(outDir, {
      version: 1, createdAt: new Date().toISOString(),
      chunks: plan.map((p) => entry(p.name, p.size, p.dict)), cold: [],
    });

    const res = mergeCold(outDir);

    // Oracle: the old buffer-and-concat build over the same members.
    const names = [...byName.keys()].sort();
    const expected = writeTar([
      ...names.map((n) => ({ name: n, data: byName.get(n)! })),
      { name: `dicts/${dictName}`, data: dictBytes },
    ]);
    const actual = readFileSync(join(outDir, 'cold', res.segment));
    assert.equal(actual.length, expected.length, 'segment length matches buffered build');
    assert.equal(
      createHash('sha256').update(actual).digest('hex'),
      createHash('sha256').update(expected).digest('hex'),
      'segment bytes identical to buffered build',
    );
    assert.deepEqual(
      readTar(actual).map((m) => m.name),
      [...names, `dicts/${dictName}`],
      'member order identical (chunks sorted, dicts last)',
    );
    assert.deepEqual(res.chunks, names, 'result chunks sorted');
    assert.deepEqual(res.dicts, [`dicts/${dictName}`], 'result dicts carried');
    assert.equal(res.bytes, expected.length, 'result bytes match tar length');
    const { manifest } = loadManifest(outDir);
    assert.equal(manifest.cold?.length, 1, 'one cold segment recorded');
    assert.deepEqual(manifest.cold?.[0].chunks, names, 'manifest chunks sorted');
    assert.equal(manifest.cold?.[0].bytes, expected.length, 'manifest bytes match tar length');
  });

  it('merges 160mb of chunks with under 32mb of extra rss', { timeout: 120_000 }, () => {
    const dir = scratch('mergestream-ram');
    const outDir = join(dir, 'archive');
    mkdirSync(join(outDir, 'warm'), { recursive: true });
    const N = 40;
    const SIZE = 4 * 1024 * 1024;
    const chunks: ChunkEntry[] = [];
    for (let i = 0; i < N; i++) {
      const name = `t-${String(i).padStart(6, '0')}.chk`;
      const body = randomBytes(SIZE - HEADER_SIZE);
      const head = encodeHeader({
        ver: 1, codec: 0, flags: 0, tableId: 7,
        seqMin: BigInt(i), seqMax: BigInt(i), tsMin: 0n, tsMax: 0n,
        rows: 1, crc32c: crc32c(body), dictId: 0, bodyLen: body.length,
      });
      writeFileSync(join(outDir, 'warm', name), Buffer.concat([head, body]));
      chunks.push(entry(name, SIZE, 0));
    }
    saveManifestAtomic(outDir, { version: 1, createdAt: new Date().toISOString(), chunks, cold: [] });

    bunRuntime.Bun?.gc(true);
    const rss0 = process.memoryUsage().rss;
    const res = mergeCold(outDir);
    bunRuntime.Bun?.gc(true);
    const rss1 = process.memoryUsage().rss;

    // Buffered tariff holds ~2x input (~320mb here); streaming holds one 1mb
    // window, so anything under 32mb proves the tariff flipped.
    assert.ok(
      rss1 - rss0 < 32 * 1024 * 1024,
      `bounded ram: rss delta ${rss1 - rss0} exceeds 32mb for ${N * SIZE} input`,
    );
    const seg = readFileSync(join(outDir, 'cold', res.segment));
    assert.equal(res.bytes, seg.length, 'result bytes match segment on disk');
    assert.equal(readTar(seg).length, N, 'every chunk lands in the segment');
    assert.equal(res.chunks.length, N, 'every chunk reported');
  });
});
