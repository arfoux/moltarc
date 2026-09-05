// molt seal — hot WAL/JSONL -> warm immutable chunks (~2MB default, 1-4MB bounds).
// Never deletes input. Advances sealed_upto_seq watermark only after fsync.
import { createHash } from 'crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { encodeChunk } from './chunk.js';
import type { HotRow } from './chunk.js';
import { trainTableDict, saveDictAtomic } from './dict.js';
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
}

export interface SealResult {
  chunks: string[];
  sealedUptoSeq: number;
  rowsSealed: number;
  rowsSkipped: number;
}

function normRow(o: Record<string, unknown>, fallbackTable: string): HotRow | null {
  const seq = Number(o.seq);
  if (!Number.isFinite(seq)) return null;
  const bodyRaw = o.body ?? o.payload ?? o.msg ?? o.data ?? '';
  return {
    device_id: String(o.device_id ?? o.device ?? 'dev0'),
    seq,
    ts: Number(o.ts ?? o.timestamp ?? Date.now()),
    id: String(o.id ?? o.trxId ?? o.trx_id ?? o.key ?? `${o.device_id ?? 'dev0'}:${seq}`),
    table: String(o.table ?? fallbackTable),
    body: typeof bodyRaw === 'string' ? bodyRaw : JSON.stringify(bodyRaw),
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

export async function seal(opts: SealOpts): Promise<SealResult> {
  const target = opts.targetBytes ?? TARGET_BYTES;
  const warm = join(opts.outDir, 'warm');
  mkdirSync(warm, { recursive: true });
  const wmPath = join(opts.outDir, 'sealed_upto_seq');
  const watermark = existsSync(wmPath) ? Number(readFileSync(wmPath, 'utf8').trim() || '0') : 0;

  // Idempotent replay: dedupe by device_id+seq, keep last; skip sealed.
  // Input auto-detect: SQLite magic -> hot.db via bun:sqlite, else JSONL WAL.
  const source = isSqliteFile(opts.hotDb)
    ? await readSqliteRows(opts.hotDb, opts.table ?? 'log')
    : readHotRows(opts.hotDb, opts.table ?? 'log');
  const seen = new Map<string, HotRow>();
  let skipped = 0;
  for (const r of source) {
    if (r.seq <= watermark) { skipped++; continue; }
    seen.set(`${r.device_id}:${r.seq}`, r);
  }
  const pending = [...seen.values()].sort((a, b) => a.seq - b.seq);
  if (pending.length === 0) {
    return { chunks: [], sealedUptoSeq: watermark, rowsSealed: 0, rowsSkipped: skipped };
  }

  // Pack rows per table; probe compressed size periodically, emit near target.
  const byTable = new Map<string, HotRow[]>();
  for (const r of pending) {
    const arr = byTable.get(r.table);
    if (arr) arr.push(r);
    else byTable.set(r.table, [r]);
  }
  const chunks: string[] = [];
  let sealedMax = watermark;
  const dictDir = join(opts.outDir, 'dicts');
  for (const [table, rows] of byTable) {
    // Per-table dictionary from leading rows when repetitive; saved content-hashed.
    const trained = trainTableDict(rows.map((r) => r.body));
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
      sealedMax = Math.max(sealedMax, batch[batch.length - 1].seq);
      batch = [];
    };
    for (const r of rows) {
      batch.push(r);
      if (batch.length % PACK_PROBE_ROWS === 0) flush(false, encodeChunk(table, batch, dict, dictId).length);
    }
    flush(true, batch.length ? encodeChunk(table, batch, dict, dictId).length : 0);
  }

  // Advance watermark only after every chunk is fsynced.
  const upto = Math.max(sealedMax, watermark);
  const tmp = `${wmPath}.tmp`;
  writeFileSync(tmp, `${upto}\n`);
  fsyncFile(tmp);
  renameSync(tmp, wmPath);

  const manifest = buildManifest(opts.outDir);
  saveManifestAtomic(opts.outDir, manifest);
  return { chunks, sealedUptoSeq: upto, rowsSealed: pending.length, rowsSkipped: skipped };
}
