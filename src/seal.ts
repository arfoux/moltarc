// moltarc seal — hot WAL/JSONL -> warm immutable chunks (~2MB default, 1-4MB bounds).
// Never deletes input. Watermark advances per flushed chunk (after fsync), so a
// kill mid-batch loses only the unflushed tail; maxRows bounds one call.
import { createHash } from 'crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { encodeChunk, sha256hex } from './chunk.js';
import type { HotRow } from './chunk.js';
import { trainTableDict, saveDictAtomic } from './dict.js';
import { checkReserve } from './gc.js';
import { requireMigrated } from './migrate.js';
import { appendEntries, buildManifest, saveManifestAtomic, scanChunk } from './manifest.js';
import type { ChunkEntry, ColdSegment } from './manifest.js';
import { saveThumb } from './thumb.js';
import { atomicWrite } from './guard.js';

export const TARGET_BYTES = 2 * 1024 * 1024;
export const MIN_BYTES = 1 * 1024 * 1024;
export const MAX_BYTES = 4 * 1024 * 1024;
// Foto gate: a base64 body decoding past this never seals inline; the raw bytes
// go to foto/<sha>.bin and the chunk keeps a foto:sha256:… hash ref instead.
export const FOTO_INLINE_LIMIT_BYTES = 256 * 1024;
// Malformed-row abort: malformed lines past this share of input fail loud.
export const MALFORMED_ABORT_PCT = 0.01;
export interface SealOpts {
  hotDb: string;
  outDir: string;
  targetBytes?: number;
  table?: string;
  trainDict?: boolean; // default true; false skips per-table zstd dicts (bench control)
  freeSpaceBytes?: number; // test seam: overrides statfs free-space reading
  maxRows?: number; // bounds one call: seals at most this many pending rows, tail stays for the next seal
}

export interface SealResult {
  chunks: string[];
  sealedUptoSeq: number; // global max across devices (compat display)
  sealedByDevice: Record<string, number>; // per-device max sealed seq
  rowsSealed: number;
  rowsSkipped: number;
  rowsMalformed: number; // input lines that failed to parse/normalize
  rowsReplaced: number; // same-key different-body overwrites (keep-last dedupe)
  probeEncodes: number; // full chunk encodes spent on size probing
}

// Fielog interop: raw cashier events (`type`/`event` bayar/undo, `nominal`
// payload) normalize with no manual conversion step.
export function normRow(o: Record<string, unknown>, fallbackTable: string): HotRow | null {
  const seq = Number(o.seq ?? o.no ?? o.nomor);
  if (!Number.isFinite(seq)) return null;
  const ts = Number(o.ts ?? o.timestamp ?? o.waktu ?? Date.now());
  if (!Number.isFinite(ts)) return null;
  const kind = o.type ?? o.event ?? o.jenis;
  const nominal = o.nominal ?? o.amount ?? o.total;
  const bodyRaw = o.body ?? o.payload ?? o.msg ?? o.data ?? o.catatan ?? o.note ?? o.keterangan ?? '';
  const device = String(o.device_id ?? o.device ?? o.kasir_id ?? 'dev0');
  const body = bodyRaw !== ''
    ? (typeof bodyRaw === 'string' ? bodyRaw : JSON.stringify(bodyRaw))
    : [
      kind !== undefined ? String(kind) : '',
      nominal !== undefined ? `nominal=${String(nominal)}` : '',
      o.kasir !== undefined ? `kasir=${String(o.kasir)}` : '',
      o.ref !== undefined ? `ref=${String(o.ref)}` : '',
      o.alasan !== undefined ? `alasan=${String(o.alasan)}` : '',
    ].filter((s) => s !== '').join(' ');
  return {
    device_id: device,
    seq,
    ts,
    id: String(o.id ?? o.trxId ?? o.trx_id ?? o.trx ?? o.key ?? `${device}:${seq}`),
    table: String(o.table ?? kind ?? fallbackTable),
    body,
  };
}

export function isSqliteFile(p: string): boolean {
  const fd = openSync(p, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    return head.toString('ascii', 0, 15) === 'SQLite format 3';
  } finally {
    closeSync(fd);
  }
}

export function readHotRowsCounted(hotDb: string, fallbackTable = 'log'): { rows: HotRow[]; malformed: number } {
  const text = readFileSync(hotDb, 'utf8');
  const rows: HotRow[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = normRow(JSON.parse(t) as Record<string, unknown>, fallbackTable);
      if (r) rows.push(r);
      else malformed++;
    } catch { malformed++; /* skip malformed WAL line, never crash seal */ }
  }
  return { rows, malformed };
}

export function readHotRows(hotDb: string, fallbackTable = 'log'): HotRow[] {
  return readHotRowsCounted(hotDb, fallbackTable).rows;
}

// Hot SQLite read (tables tx/log with device_id,seq,ts,id,table,body).
// Runs only under bun; node callers get a clear error instead of a crash.
export async function readSqliteRowsCounted(hotDb: string, fallbackTable = 'log'): Promise<{ rows: HotRow[]; malformed: number }> {
  let sqlite: typeof import('bun:sqlite');
  try {
    // Platform module absent outside bun: dynamic import is the only option.
    sqlite = await import('bun:sqlite');
  } catch {
    throw new Error('hot.db sqlite input needs the bun runtime (bun:sqlite)');
  }
  const db = new sqlite.Database(hotDb, { readonly: true });
  try {
    const names = db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    const picked = [fallbackTable !== 'log' ? fallbackTable : '', 'tx', 'log'].find((n) => n && names.includes(n))
      ?? names[0];
    if (!picked) throw new Error(`no tables in ${hotDb}`);
    const raw = db.query<Record<string, unknown>>(
      `SELECT device_id, seq, ts, id, "table", body FROM "${picked.replace(/"/g, '')}" ORDER BY seq`,
    ).all();
    const rows: HotRow[] = [];
    let malformed = 0;
    for (const o of raw) {
      const r = normRow(o, picked);
      if (r) rows.push(r);
      else malformed++;
    }
    return { rows, malformed };
  } finally {
    db.close();
  }
}

export async function readSqliteRows(hotDb: string, fallbackTable = 'log'): Promise<HotRow[]> {
  return (await readSqliteRowsCounted(hotDb, fallbackTable)).rows;
}

const FOTO_REF_RE = /^foto:sha256:[0-9a-f]{64}:size=\d+$/;
const B64_CHARS_RE = /^[A-Za-z0-9+/=\r\n]+$/;

export function isFotoRef(body: string): boolean {
  return FOTO_REF_RE.test(body);
}

// Foto gate: a base64 body decoding past FOTO_INLINE_LIMIT_BYTES is quarantined
// to a sidecar file under <outDir>/foto/<sha>.bin; returns the hash ref to seal
// instead of the inline bytes. Small bodies and non-base64 text return null and
// keep sealing inline as before.
export function quarantineFotoBody(outDir: string, body: string): string | null {
  const chars = body.replace(/\s/g, '');
  // Fast path: shorter strings cannot decode past the limit; no base64 work.
  if (chars.length < (FOTO_INLINE_LIMIT_BYTES * 4) / 3) return null;
  if (chars.length % 4 !== 0 || !B64_CHARS_RE.test(chars)) return null;
  let raw: Buffer;
  try {
    raw = Buffer.from(chars, 'base64');
  } catch {
    return null;
  }
  if (raw.length <= FOTO_INLINE_LIMIT_BYTES) return null;
  // Strict re-encode: base64 decode is lenient, large prose must not match.
  if (raw.toString('base64') !== chars) return null;
  const sha = createHash('sha256').update(raw).digest('hex');
  const dir = join(outDir, 'foto');
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${sha}.bin`);
  if (!existsSync(dest)) {
    writeFileSync(dest, raw);
    fsyncFile(dest);
  }
  // Sidecar preview: best-effort, never fails the seal; the .bin stays authoritative.
  try { saveThumb(outDir, raw); } catch { /* thumb fallback already avoids throws */ }
  return `foto:sha256:${sha}:size=${raw.length}`;
}

// Read back quarantined foto bytes for a hash ref produced by quarantineFotoBody.
export function readFotoSidecar(outDir: string, ref: string): Buffer {
  const m = /^foto:sha256:([0-9a-f]{64}):size=(\d+)$/.exec(ref);
  if (!m) throw new Error(`not a foto ref: ${ref.slice(0, 32)}`);
  return readFileSync(join(outDir, 'foto', `${m[1]}.bin`));
}

function fsyncFile(p: string): void {
  const fd = openSync(p, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function sanitizeTable(t: string): string {
  return t.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32) || 'log';
}

export function chunkName(table: string, seqMin: number, seqMax: number, bytes: Buffer): string {
  const sha8 = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  const pad = (n: number) => String(n).padStart(8, '0');
  return `${sanitizeTable(table)}-${pad(seqMin)}-${pad(seqMax)}-${sha8}.chk`;
}
// Per-device watermark: sealed_upto_seq holds a JSON map of device_id to
// max sealed seq. A global r.seq <= watermark check drops slow devices
// silently (kasir-02 seq 1..3 all fall under kasir-01 seq 1..5), so the
// skip and the advance below are both keyed by device_id.
// Legacy single-number files predate multi-device sealing: the old global
// check skipped seq <= N for every device, so N floors each device seen
// now. The rewrite is always per-device; re-fed ancient rows may reseal
// as dupes (loud) instead of dropping new rows (silent).
function readWatermark(wmPath: string): Record<string, number> {
  if (!existsSync(wmPath)) return {};
  const text = readFileSync(wmPath, 'utf8').trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'number') {
      return Number.isFinite(parsed) && parsed > 0 ? { '': parsed } : {};
    }
    if (parsed && typeof parsed === 'object') {
      const wm: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) wm[k] = v;
      }
      return wm;
    }
  } catch { /* not json: fall through to the legacy plain number */ }
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? { '': n } : {};
}

export async function seal(opts: SealOpts): Promise<SealResult> {
  // Downgrade guard first: refuse old manifests, but a fresh outDir with no
  // manifest yet seals normally (nothing to migrate).
  requireMigrated(opts.outDir);
  const target = opts.targetBytes ?? TARGET_BYTES;
  const warm = join(opts.outDir, 'warm');
  mkdirSync(warm, { recursive: true });
  // Reserve-space rule: refuse before any chunk/watermark/manifest write
  // when free space drops below 50MB, so a seal never half-writes.
  checkReserve(opts.outDir, opts.freeSpaceBytes);
  const wmPath = join(opts.outDir, 'sealed_upto_seq');
  const wm = readWatermark(wmPath);

  // Idempotent replay: dedupe by device_id+seq+table, keep last; skip sealed.
  // Input auto-detect: SQLite magic -> hot.db via bun:sqlite, else JSONL WAL.
  const counted = isSqliteFile(opts.hotDb)
    ? await readSqliteRowsCounted(opts.hotDb, opts.table ?? 'log')
    : readHotRowsCounted(opts.hotDb, opts.table ?? 'log');
  const malformed = counted.malformed;
  const total = counted.rows.length + malformed;
  if (total > 0 && malformed / total > MALFORMED_ABORT_PCT) {
    throw new Error(`seal aborted: ${malformed}/${total} malformed rows (>${MALFORMED_ABORT_PCT * 100}%)`);
  }
  const source = counted.rows;
  const seen = new Map<string, HotRow>();
  let skipped = 0;
  let replaced = 0;
  for (const r of source) {
    if (r.seq <= Math.max(wm[r.device_id] ?? 0, wm[''] ?? 0)) { skipped++; continue; }
    const key = `${r.device_id}:${r.seq}:${r.table}`;
    const prev = seen.get(key);
    if (prev !== undefined && prev.body !== r.body) replaced++;
    seen.set(key, r);
  }
  const sorted = [...seen.values()].sort((a, b) => a.seq - b.seq || (a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : 0));
  // Bounded seal: only the head of the queue seals this call; the tail stays
  // pending (unwatermarked) for the next call.
  const cap = opts.maxRows ?? sorted.length;
  const pending = sorted.slice(0, Math.max(0, cap));
  const wmMax = Math.max(0, ...Object.values(wm));
  if (pending.length === 0) {
    const byDevice: Record<string, number> = {};
    for (const [k, v] of Object.entries(wm)) if (k !== '') byDevice[k] = v;
    return { chunks: [], sealedUptoSeq: wmMax, sealedByDevice: byDevice, rowsSealed: 0, rowsSkipped: skipped, rowsMalformed: malformed, rowsReplaced: replaced, probeEncodes: 0 };
  }

  // Foto gate first: oversize base64 never reaches a chunk inline.
  for (const r of pending) {
    const ref = quarantineFotoBody(opts.outDir, r.body);
    if (ref !== null) r.body = ref;
  }

  // Per-chunk watermark: every flush fsyncs its chunk, then persists the
  // per-device advance. A kill between flushes loses only the unflushed tail,
  // which still sits below the watermark and reseals on the next call.
  const advanced: Record<string, number> = {};
  for (const [k, v] of Object.entries(wm)) if (k !== '') advanced[k] = v;
  const persistWatermark = (): void => {
    const ordered: Record<string, number> = {};
    for (const k of Object.keys(advanced).sort()) ordered[k] = advanced[k];
    atomicWrite(wmPath, `${JSON.stringify(ordered)}\n`);
  };

  // Pack rows per table; a raw-bytes x last-ratio estimate gates full encodes,
  // which run only near the target (plus one calibration per table and a
  // recalibration every 4000 rows so the ratio tracks corpus drift).
  const byTable = new Map<string, HotRow[]>();
  for (const r of pending) {
    const arr = byTable.get(r.table);
    if (arr) arr.push(r);
    else byTable.set(r.table, [r]);
  }
  const chunks: string[] = [];
  let probeEncodes = 0;
  const dictDir = join(opts.outDir, 'dicts');
  for (const [table, rows] of byTable) {
    // Per-table dictionary from leading rows when repetitive; saved content-hashed.
    // trainDict:false skips training (bench control for the dict on/off delta).
    const trained = (opts.trainDict ?? true) ? trainTableDict(rows.map((r) => r.body), table) : null;
    if (trained) saveDictAtomic(dictDir, trained.dict, trained.dictId);
    const dict = trained?.dict;
    const dictId = trained?.dictId ?? 0;
    let batch: HotRow[] = [];
    let batchRaw = 0;
    let lastRatio = 0.5; // compressed bytes per raw byte; probes recalibrate
    let recalAt = 0;
    let lastProbeAt = 0;
    let calibrated = false;
    const rowSize = (r: HotRow): number =>
      Buffer.byteLength(r.body) + Buffer.byteLength(r.id) + Buffer.byteLength(r.device_id) + 48;
    const probe = (): Buffer => {
      const out = encodeChunk(table, batch, dict, dictId);
      probeEncodes++;
      if (batchRaw > 0) lastRatio = out.length / batchRaw;
      return out;
    };
    const flush = (force: boolean, probed?: Buffer) => {
      if (batch.length === 0) return;
      if (!force && (probed?.length ?? 0) < target) return;
      const out = probed ?? encodeChunk(table, batch, dict, dictId);
      // Oversize probe above MAX still ships: chunks stay immutable, tail rule wins.
      const name = chunkName(table, batch[0].seq, batch[batch.length - 1].seq, out);
      const dest = join(warm, name);
      if (!existsSync(dest)) {
        writeFileSync(dest, out);
        fsyncFile(dest);
      }
      chunks.push(dest);
      for (const r of batch) advanced[r.device_id] = Math.max(advanced[r.device_id] ?? 0, r.seq);
      persistWatermark();
      batch = [];
      batchRaw = 0;
      recalAt = 0;
      lastProbeAt = 0;
    };
    for (const r of rows) {
      batch.push(r);
      batchRaw += rowSize(r);
      if (!calibrated && batch.length >= 400) {
        calibrated = true;
        recalAt = batch.length;
        lastProbeAt = batch.length;
        flush(false, probe());
        continue;
      }
      if (batch.length - recalAt >= 4000) {
        recalAt = batch.length;
        lastProbeAt = batch.length;
        flush(false, probe());
        continue;
      }
      const est = batchRaw * lastRatio;
      if (est < target * 0.5) continue;
      const gap = est >= target ? 100 : 400;
      if (batch.length - lastProbeAt >= gap) {
        lastProbeAt = batch.length;
        flush(false, probe());
      }
    }
    flush(true);
  }

  // Manifest once at the end: append-only fast path merges caller-scanned
  // entries into the best crc-valid copy, no full warm rescan. ordering,
  // fsync, and dual-copy behavior stay identical: appendEntries sorts by
  // filename and saves via the same atomic dual-copy path. the watermark
  // already covers each chunk; a kill before this point only repeats
  // manifest work on the next seal.
  const upto = Math.max(0, ...Object.values(advanced));
  const ordered: Record<string, number> = {};
  for (const k of Object.keys(advanced).sort()) ordered[k] = advanced[k];

  const hasManifest =
    existsSync(join(opts.outDir, 'manifest.json')) || existsSync(join(opts.outDir, 'manifest.bak.json'));
  if (hasManifest) {
    const dictDir = join(opts.outDir, 'dicts');
    const entries: ChunkEntry[] = [];
    for (const dest of chunks) {
      const name = basename(dest);
      try {
        entries.push(scanChunk(dest, name, dictDir));
      } catch {
        // Corrupt just-flushed chunk: quarantine stub mirrors buildManifest
        // so history survives minus one chunk.
        const buf = readFileSync(dest);
        entries.push({
          file: name, table: name.split('-')[0],
          seqMin: 0, seqMax: 0, tsMin: 0, tsMax: 0, rows: 0, bytes: buf.length,
          sha256: sha256hex(buf), crc32c: 0, dictId: 0, codec: 0,
          minKey: '', maxKey: '', bloom: '', quarantined: true,
        });
      }
    }
    appendEntries(opts.outDir, entries);
    return { chunks, sealedUptoSeq: upto, sealedByDevice: ordered, rowsSealed: pending.length, rowsSkipped: skipped, rowsMalformed: malformed, rowsReplaced: replaced, probeEncodes };
  }

  // First seal (no prior manifest): full rebuild owns the listing.
  // Preserve cold listing: buildManifest scans warm only, so reattach the
  // prior cold[] (tars stay on disk) or the next merge repacks warm twice.
  let cold: ColdSegment[] | undefined;
  for (const name of ['manifest.json', 'manifest.bak.json']) {
    try {
      const prev = JSON.parse(readFileSync(join(opts.outDir, name), 'utf8')) as { cold?: ColdSegment[] };
      if (Array.isArray(prev.cold)) { cold = prev.cold; break; }
    } catch { /* no prior manifest: first seal */
    }
  }
  const manifest = buildManifest(opts.outDir);
  if (cold !== undefined) manifest.cold = cold;
  saveManifestAtomic(opts.outDir, manifest);
  return { chunks, sealedUptoSeq: upto, sealedByDevice: ordered, rowsSealed: pending.length, rowsSkipped: skipped, rowsMalformed: malformed, rowsReplaced: replaced, probeEncodes };
}
