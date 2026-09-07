// moltarc chunk codec — 64B header + columnar frame + zstd (deflate fallback).
// Header layout (all LE, total 64B):
//   0-3  magic "UMK1" | 4-5 ver u16 | 6 codec u8 | 7 flags u8
//   8-11 tableId u32 (fnv1a32 of table) | 12-19 seqMin u64 | 20-27 seqMax u64
//   28-35 tsMin i64 | 36-43 tsMax i64 | 44-47 rows u32 | 48-51 crc32c u32 (of body)
//   52-55 dictId u32 | 56-59 bodyLen u32 | 60-63 reserved u32
import { createHash } from 'crypto';
import { deflateSync, inflateSync, zstdCompressSync, zstdDecompressSync } from 'zlib';

export const MAGIC = 'UMK1';
export const VERSION = 1;
export const HEADER_SIZE = 64;
export const CODEC_NONE = 0;
export const CODEC_ZSTD = 1;
export const CODEC_DEFLATE = 2;

export interface HotRow {
  device_id: string;
  seq: number;
  ts: number;
  id: string;
  table: string;
  body: string;
}

export interface ChunkHeader {
  ver: number;
  codec: number;
  flags: number;
  tableId: number;
  seqMin: bigint;
  seqMax: bigint;
  tsMin: bigint;
  tsMax: bigint;
  rows: number;
  crc32c: number;
  dictId: number;
  bodyLen: number;
}

// --- fnv1a32 ---
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// --- crc32c (Castagnoli, reflected poly 0x82F63B78) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32c(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function sha256hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

// --- header ---
export function encodeHeader(h: ChunkHeader): Buffer {
  const b = Buffer.alloc(HEADER_SIZE);
  b.write(MAGIC, 0, 'ascii');
  b.writeUInt16LE(h.ver, 4);
  b.writeUInt8(h.codec, 6);
  b.writeUInt8(h.flags, 7);
  b.writeUInt32LE(h.tableId >>> 0, 8);
  b.writeBigUInt64LE(h.seqMin, 12);
  b.writeBigUInt64LE(h.seqMax, 20);
  b.writeBigInt64LE(h.tsMin, 28);
  b.writeBigInt64LE(h.tsMax, 36);
  b.writeUInt32LE(h.rows >>> 0, 44);
  b.writeUInt32LE(h.crc32c >>> 0, 48);
  b.writeUInt32LE(h.dictId >>> 0, 52);
  b.writeUInt32LE(h.bodyLen >>> 0, 56);
  b.writeUInt32LE(0, 60);
  return b;
}

export function decodeHeader(buf: Uint8Array): ChunkHeader {
  if (buf.length < HEADER_SIZE) throw new Error(`chunk too small: ${buf.length}B`);
  const b = Buffer.from(buf.subarray(0, HEADER_SIZE));
  if (b.toString('ascii', 0, 4) !== MAGIC) throw new Error('bad magic: not a UMK1 chunk');
  const ver = b.readUInt16LE(4);
  if (ver !== 0 && ver !== 1) throw new Error(`unsupported header ver ${ver} (N-2 compat: supports ver 0-1)`);
  return {
    ver,
    codec: b.readUInt8(6),
    flags: b.readUInt8(7),
    tableId: b.readUInt32LE(8),
    seqMin: b.readBigUInt64LE(12),
    seqMax: b.readBigUInt64LE(20),
    tsMin: b.readBigInt64LE(28),
    tsMax: b.readBigInt64LE(36),
    rows: b.readUInt32LE(44),
    crc32c: b.readUInt32LE(48),
    dictId: b.readUInt32LE(52),
    bodyLen: b.readUInt32LE(56),
  };
}

// --- compression backend: zstd preferred, deflate fallback ---
// A trained per-table dictionary narrows repetitive frames further.
// Chunks carrying it set DICT_FLAG and name dict_id; flagless chunks
// (everything sealed before dicts existed) decode with no dictionary.
export const DICT_FLAG = 0x02;

export function compressFrame(raw: Buffer, dict?: Buffer): { codec: number; body: Buffer; usedDict: boolean } {
  if (dict) {
    try {
      return { codec: CODEC_ZSTD, body: Buffer.from(zstdCompressSync(raw, { dictionary: dict })), usedDict: true };
    } catch { /* runtimes without dict support fall through to plain */ }
  }
  try {
    return { codec: CODEC_ZSTD, body: Buffer.from(zstdCompressSync(raw)), usedDict: false };
  } catch {
    return { codec: CODEC_DEFLATE, body: Buffer.from(deflateSync(raw)), usedDict: false };
  }
}

// Hard cap on decompressed frame bytes: enforced in decompressFrame and
// re-checked in decodeChunk before JSON.parse. Bomb frames fail loud.
export const DECOMPRESS_MAX_BYTES = 16 * 1024 * 1024;

function checkFrameCap(out: Buffer): Buffer {
  if (out.length > DECOMPRESS_MAX_BYTES) {
    throw new Error(`decompressed frame ${out.length}B exceeds ${DECOMPRESS_MAX_BYTES}B cap (likely corrupt)`);
  }
  return out;
}

// Low-level backend: caller must gate `dict` on DICT_FLAG first (decodeChunk
// does: supplied dict is ignored when the flag is off). dictId is accepted
// for call compat and otherwise unused.
export function decompressFrame(codec: number, body: Buffer, dict?: Buffer, dictId = 0): Buffer {
  void dictId;
  // zstd has no maxOutputLength option, so its output is capped by checkFrameCap after inflate.
  if (codec === CODEC_ZSTD && dict) return checkFrameCap(Buffer.from(zstdDecompressSync(body, { dictionary: dict })));
  if (codec === CODEC_ZSTD && !dict) return checkFrameCap(Buffer.from(zstdDecompressSync(body)));
  if (codec === CODEC_DEFLATE) return checkFrameCap(Buffer.from(inflateSync(body, { maxOutputLength: DECOMPRESS_MAX_BYTES })));
  if (codec === CODEC_NONE) return checkFrameCap(body);
  throw new Error(`unsupported codec ${codec} (N-2 compat: upgrade moltarc)`);
}

// --- columnar frame: delta (seq/ts) + dict (device_id) + RLE (body) ---
interface Frame {
  v: number;
  table: string;
  dev: string[];
  seqB: number;
  seqD: number[];
  tsB: number;
  tsD: number[];
  ids: string[];
  devI: number[];
  pool: string[];
  runs: Array<[number, number]>;
}

export function encodeRows(rows: HotRow[]): { raw: Buffer; dictId: number } {
  const table = rows[0]?.table ?? 'log';
  const dev: string[] = [];
  const devIdx = new Map<string, number>();
  const pool: string[] = [];
  const poolIdx = new Map<string, number>();
  const seqD: number[] = [];
  const tsD: number[] = [];
  const ids: string[] = [];
  const devI: number[] = [];
  const runs: Array<[number, number]> = [];
  let prevSeq = rows[0]?.seq ?? 0;
  let prevTs = rows[0]?.ts ?? 0;
  rows.forEach((r, i) => {
    let d = devIdx.get(r.device_id);
    if (d === undefined) { d = dev.length; devIdx.set(r.device_id, d); dev.push(r.device_id); }
    devI.push(d);
    ids.push(r.id);
    seqD.push(i === 0 ? 0 : r.seq - prevSeq);
    tsD.push(i === 0 ? 0 : r.ts - prevTs);
    prevSeq = r.seq; prevTs = r.ts;
    let p = poolIdx.get(r.body);
    if (p === undefined) { p = pool.length; poolIdx.set(r.body, p); pool.push(r.body); }
    const last = runs[runs.length - 1];
    if (last && last[0] === p) last[1]++;
    else runs.push([p, 1]);
  });
  const frame: Frame = {
    v: 1, table, dev,
    seqB: rows[0]?.seq ?? 0, seqD,
    tsB: rows[0]?.ts ?? 0, tsD,
    ids, devI, pool, runs,
  };
  const raw = Buffer.from(JSON.stringify(frame), 'utf8');
  const dictId = rows.length ? fnv1a32(dev.join('\0') + '\0' + pool.join('\0')) : 0;
  return { raw, dictId };
}

export function decodeRows(raw: Buffer): HotRow[] {
  const f = JSON.parse(raw.toString('utf8')) as Frame;
  // Dictionary/frame integrity: a deleted or truncated pool must fail loud,
  // never decode into silently wrong rows.
  if (!Array.isArray(f.ids) || !Array.isArray(f.devI) || !Array.isArray(f.pool)
    || !Array.isArray(f.runs) || !Array.isArray(f.dev) || !Array.isArray(f.seqD) || !Array.isArray(f.tsD)) {
    throw new Error('frame corrupt: missing column or dictionary array');
  }
  if (f.ids.length !== f.devI.length || f.ids.length !== f.seqD.length || f.ids.length !== f.tsD.length) {
    throw new Error('frame corrupt: column length mismatch');
  }
  if (f.runs.length > 0 && f.pool.length === 0) {
    throw new Error('frame corrupt: body dictionary deleted');
  }
  if (f.dev.length === 0 && f.ids.length > 0) {
    throw new Error('frame corrupt: device dictionary deleted');
  }
  // Pre-check before expansion: a bomb run (n >> ids) would otherwise push
  // gigabytes of duplicated refs before the count check below ever runs.
  // Validated indexes make the expansion loop below provably in-range.
  let planned = 0;
  for (const [p, n] of f.runs) {
    if (!Number.isInteger(p) || p < 0 || p >= f.pool.length) {
      throw new Error(`frame corrupt: body dictionary index ${String(p)} out of range`);
    }
    if (!Number.isInteger(n) || n <= 0) throw new Error('frame corrupt: bad run length');
    planned += n;
    if (planned > f.ids.length) throw new Error('frame corrupt: body run count exceeds rows');
  }
  const bodies: string[] = [];
  for (const [p, n] of f.runs) {
    for (let i = 0; i < n; i++) bodies.push(f.pool[p]);
  }
  if (bodies.length !== f.ids.length) throw new Error('frame corrupt: body run count mismatch');
  const rows: HotRow[] = [];
  let seq = f.seqB;
  let ts = f.tsB;
  for (let i = 0; i < f.ids.length; i++) {
    if (i > 0) { seq += f.seqD[i]; ts += f.tsD[i]; }
    const device = f.dev[f.devI[i]];
    if (device === undefined) throw new Error(`frame corrupt: device dictionary index ${String(f.devI[i])} out of range`);
    rows.push({ device_id: device, seq, ts, id: f.ids[i], table: f.table, body: bodies[i] });
  }
  return rows;
}

// --- full chunk encode/decode ---
export function encodeChunk(table: string, rows: HotRow[], dict?: Buffer, dictId = 0): Buffer {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const { raw, dictId: inlineId } = encodeRows(sorted);
  const { codec, body, usedDict } = compressFrame(raw, dict);
  const seqs = sorted.map((r) => BigInt(r.seq));
  const tss = sorted.map((r) => BigInt(r.ts));
  const header = encodeHeader({
    ver: VERSION, codec, flags: (inlineId ? 1 : 0) | (usedDict ? DICT_FLAG : 0),
    tableId: fnv1a32(table),
    seqMin: seqs[0] ?? 0n, seqMax: seqs[seqs.length - 1] ?? 0n,
    tsMin: tss[0] ?? 0n, tsMax: tss[tss.length - 1] ?? 0n,
    rows: sorted.length, crc32c: crc32c(body), dictId: usedDict ? dictId : inlineId, bodyLen: body.length,
  });
  return Buffer.concat([header, body]);
}
// Full chunk decode: body crc first, then dict gating, cap, frame checks.
// Header integrity: crc covers the body only (frozen v1 layout), so header
// seqMin/seqMax/tsMin/tsMax/rows are cross-checked against decoded rows.
// header.dictId with DICT_FLAG off is a non-authoritative inline hint
// (pre-dict chunks carry any dict_id): ignored on decode, never verified.
export function decodeChunk(buf: Buffer, dict?: Buffer): { header: ChunkHeader; rows: HotRow[] } {
  const header = decodeHeader(buf);
  const body = Buffer.from(buf.subarray(HEADER_SIZE, HEADER_SIZE + header.bodyLen));
  if (body.length !== header.bodyLen) throw new Error('truncated chunk body');
  if (crc32c(body) !== header.crc32c) throw new Error('crc32c mismatch: corrupt chunk body');
  if ((header.flags & DICT_FLAG) !== 0 && !dict) {
    throw new Error(`chunk needs dict ${(header.dictId >>> 0).toString(16).padStart(8, '0')} (dict file missing)`);
  }
  // Gate: ignore a supplied dict when the chunk names none (flag off), so a
  // stray dict file can never mis-decode a flagless chunk.
  const useDict = (header.flags & DICT_FLAG) !== 0 ? dict : undefined;
  const raw = decompressFrame(header.codec, body, useDict, header.dictId);
  if (raw.length > DECOMPRESS_MAX_BYTES) {
    throw new Error(`decompressed frame ${raw.length}B exceeds ${DECOMPRESS_MAX_BYTES}B cap (likely corrupt)`);
  }
  const rows = decodeRows(raw);
  if (rows.length !== header.rows) throw new Error(`header rows ${header.rows} vs decoded ${rows.length}`);
  if (rows.length > 0 && (header.tableId >>> 0) !== fnv1a32(rows[0].table)) throw new Error('header tableId differs from frame table');
  if (rows.length > 0) {
    let smin = rows[0].seq;
    let smax = rows[0].seq;
    let tmin = rows[0].ts;
    let tmax = rows[0].ts;
    for (let i = 1; i < rows.length; i++) {
      const s = rows[i].seq;
      const t = rows[i].ts;
      if (s < smin) smin = s;
      if (s > smax) smax = s;
      if (t < tmin) tmin = t;
      if (t > tmax) tmax = t;
    }
    if (BigInt(smin) !== header.seqMin || BigInt(smax) !== header.seqMax) {
      throw new Error('header seq range differs from decoded rows (corrupt header/frame)');
    }
    if (BigInt(tmin) !== header.tsMin || BigInt(tmax) !== header.tsMax) {
      throw new Error('header ts range differs from decoded rows (corrupt header/frame)');
    }
  }
  return { header, rows };
}
