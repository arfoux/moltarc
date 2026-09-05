// molt seal — hot WAL/JSONL -> warm immutable chunks (~2MB default, 1-4MB bounds).
// Never deletes input. Advances sealed_upto_seq watermark only after fsync.
import { createHash } from 'crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { encodeChunk } from './chunk.js';
import type { HotRow } from './chunk.js';
import { trainTableDict, saveDictAtomic } from './dict.js';
import { checkReserve } from './gc.js';
import { buildManifest, saveManifestAtomic } from './manifest.js';

export const TARGET_BYTES = 2 * 1024 * 1024;
export const MIN_BYTES = 1 * 1024 * 1024;
export const MAX_BYTES = 4 * 1024 * 1024;
const PACK_PROBE_ROWS = 400;
export interface SealOpts {
  hotDb: string;
  outDir: string;
  targetBytes?: number;
  table?: string;
  trainDict?: boolean; // default true; false skips per-table zstd dicts (bench control)
  freeSpaceBytes?: number; // test seam: overrides statfs free-space reading
}

export interface SealResult {
  chunks: string[];
  sealedUptoSeq: number; // global max across devices (compat display)
  sealedByDevice: Record<string, number>; // per-device max sealed seq
  rowsSealed: number;
  rowsSkipped: number;
}

// Fielog interop: raw cashier events (`type`/`event` bayar/undo, `nominal`
// payload) normalize with no manual conversion step.
export function normRow(o: Record<string, unknown>, fallbackTable: string): HotRow | null {
  const seq = Number(o.seq ?? o.no ?? o.nomor);
  if (!Number.isFinite(seq)) return null;
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
    ts: Number(o.ts ?? o.timestamp ?? o.waktu ?? Date.now()),
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

export function readHotRows(hotDb: string, fallbackTable = 'log'): HotRow[] {
  const text = readFileSync(hotDb, 'utf8');
  const rows: HotRow[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = normRow(JSON.parse(t) as Record<string, unknown>, fallbackTable);
      if (r) rows.push(r);
    } catch { /* skip malformed WAL line, never crash seal */ }
  }
  return rows;
}

// Hot SQLite read (tables tx/log with device_id,seq,ts,id,table,body).
// Runs only under bun; node callers get a clear error instead of a crash.
export async function readSqliteRows(hotDb: string, fallbackTable = 'log'): Promise<HotRow[]> {
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
    for (const o of raw) {
      const r = normRow(o, picked);
      if (r) rows.push(r);
    }
    return rows;
  } finally {
    db.close();
  }
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
  const target = opts.targetBytes ?? TARGET_BYTES;
  const warm = join(opts.outDir, 'warm');
  mkdirSync(warm, { recursive: true });
  // Reserve-space rule: refuse before any chunk/watermark/manifest write
  // when free space drops below 50MB, so a seal never half-writes.
  checkReserve(opts.outDir, opts.freeSpaceBytes);
  const wmPath = join(opts.outDir, 'sealed_upto_seq');
  const wm = readWatermark(wmPath);

  // Idempotent replay: dedupe by device_id+seq, keep last; skip sealed.
  // Input auto-detect: SQLite magic -> hot.db via bun:sqlite, else JSONL WAL.
  const source = isSqliteFile(opts.hotDb)
    ? await readSqliteRows(opts.hotDb, opts.table ?? 'log')
    : readHotRows(opts.hotDb, opts.table ?? 'log');
  const seen = new Map<string, HotRow>();
  let skipped = 0;
  for (const r of source) {
    if (r.seq <= Math.max(wm[r.device_id] ?? 0, wm[''] ?? 0)) { skipped++; continue; }
    seen.set(`${r.device_id}:${r.seq}`, r);
  }
  const pending = [...seen.values()].sort((a, b) => a.seq - b.seq || (a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : 0));
  const wmMax = Math.max(0, ...Object.values(wm));
  if (pending.length === 0) {
    const byDevice: Record<string, number> = {};
    for (const [k, v] of Object.entries(wm)) if (k !== '') byDevice[k] = v;
    return { chunks: [], sealedUptoSeq: wmMax, sealedByDevice: byDevice, rowsSealed: 0, rowsSkipped: skipped };
  }

  // Pack rows per table; probe compressed size periodically, emit near target.
  const byTable = new Map<string, HotRow[]>();
  for (const r of pending) {
    const arr = byTable.get(r.table);
    if (arr) arr.push(r);
    else byTable.set(r.table, [r]);
  }
  const chunks: string[] = [];
  const dictDir = join(opts.outDir, 'dicts');
  for (const [table, rows] of byTable) {
    // Per-table dictionary from leading rows when repetitive; saved content-hashed.
    // trainDict:false skips training (bench control for the dict on/off delta).
    const trained = (opts.trainDict ?? true) ? trainTableDict(rows.map((r) => r.body)) : null;
    if (trained) saveDictAtomic(dictDir, trained.dict, trained.dictId);
    const dict = trained?.dict;
    const dictId = trained?.dictId ?? 0;
    let batch: HotRow[] = [];
    const flush = (force: boolean, probeBytes: number) => {
      if (batch.length === 0) return;
      if (!force && probeBytes < target) return;
      const bytes = encodeChunk(table, batch, dict, dictId);
      // Oversize probe above MAX still ships: chunks stay immutable, tail rule wins.
      const name = chunkName(table, batch[0].seq, batch[batch.length - 1].seq, bytes);
      const dest = join(warm, name);
      if (!existsSync(dest)) {
        writeFileSync(dest, bytes);
        fsyncFile(dest);
      }
      chunks.push(dest);
      batch = [];
    };
    for (const r of rows) {
      batch.push(r);
      if (batch.length % PACK_PROBE_ROWS === 0) flush(false, encodeChunk(table, batch, dict, dictId).length);
    }
    flush(true, batch.length ? encodeChunk(table, batch, dict, dictId).length : 0);
  }

  // Advance the per-device watermark only after every chunk is fsynced.
  // Every pending row lands in exactly one flushed batch, so the advance
  // is the per-device max over pending. The legacy '' floor is dropped:
  // each device seen now carries its own entry going forward.
  const advanced: Record<string, number> = {};
  for (const [k, v] of Object.entries(wm)) if (k !== '') advanced[k] = v;
  for (const r of pending) advanced[r.device_id] = Math.max(advanced[r.device_id] ?? 0, r.seq);
  const upto = Math.max(0, ...Object.values(advanced));
  const ordered: Record<string, number> = {};
  for (const k of Object.keys(advanced).sort()) ordered[k] = advanced[k];
  const tmp = `${wmPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ordered)}\n`);
  fsyncFile(tmp);
  renameSync(tmp, wmPath);

  const manifest = buildManifest(opts.outDir);
  saveManifestAtomic(opts.outDir, manifest);
  return { chunks, sealedUptoSeq: upto, sealedByDevice: ordered, rowsSealed: pending.length, rowsSkipped: skipped };
}
