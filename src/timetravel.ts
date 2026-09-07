// moltarc timetravel — read-only state as-of (seq | ts).
// Fold order is seqMin ascending; latest row per id with seq/ts <= target wins.
// O(k) achieved via range prune: only chunks with seqMin/tsMin <= target are
// decoded; future chunks (min > target) are pruned without I/O. Bloom is not
// applicable here — timetravel filters by seq/ts, not id — so range prune is
// the sole pre-decode filter (mirrors candidates() tail-prune but keyed on
// seq/ts). Kept chunks are still decoded and row-filtered individually.
// Read-only: loadManifest + readFileSync + decodeChunk (crc proof inside).
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { decodeChunk, decodeHeader, DICT_FLAG, type HotRow } from './chunk.js';
import { loadDictFor } from './dict.js';
import { loadManifest } from './manifest.js';

export interface TimeTravelOpts {
  outDir: string;
  seq?: number;
  ts?: number;
  chunkDir?: string;
}

export interface TimeTravelProof {
  chunksConsulted: string[];
  chunksPruned: number;
  skippedMissing: number;
  manifestSource: string;
}

export interface TimeTravelResult {
  rows: HotRow[];
  proof: TimeTravelProof;
}

export function queryAsOf(opts: TimeTravelOpts): TimeTravelResult {
  const hasSeq = typeof opts.seq === 'number';
  const hasTs = typeof opts.ts === 'number';
  if (hasSeq === hasTs) throw new Error('queryAsOf: exactly one of seq|ts is required');
  const targetSeq = hasSeq ? Math.floor(opts.seq as number) : null;
  const targetTs = hasTs ? (opts.ts as number) : null;
  if (targetSeq !== null && !(targetSeq >= 0)) throw new Error('queryAsOf: seq must be >= 0');
  if (targetTs !== null && !Number.isFinite(targetTs)) throw new Error('queryAsOf: ts must be finite');

  const dir = opts.chunkDir ?? join(opts.outDir, 'warm');
  const dictDir = join(dir, '..', 'dicts');
  const { manifest, source } = loadManifest(opts.outDir);

  // Range prune mirrors candidates() tail-prune, keyed on seq/ts not trx id.
  // O(k) via range prune: prune future chunks where target < min; bloom
  // pruning is skipped — timetravel has no id predicate, so bloomCheckScaled
  // is not applicable (kept for findTrx point queries only).
  const kept = [];
  let pruned = 0;
  for (const e of manifest.chunks) {
    if (e.quarantined) { pruned++; continue; }
    if (hasSeq) {
      // Prune only future chunks; seqMax < target still needed (all rows <= target)
      if ((targetSeq as number) < e.seqMin) { pruned++; continue; }
      // bloom not applicable: no id filter, keep range-pruned set as-is
    } else {
      if ((targetTs as number) < e.tsMin) { pruned++; continue; }
    }
    kept.push(e);
  }
  if (kept.length > 1000) console.warn(`timetravel: ${kept.length} chunks kept exceeds 1000, query may be slow (target ${hasSeq ? `seq=${targetSeq}` : `ts=${targetTs}`})`);
  kept.sort((a, b) => a.seqMin - b.seqMin);
  const consulted: string[] = [];
  let skippedMissing = 0;
  const state = new Map<string, HotRow>();
  for (const e of kept) {
    const full = join(dir, e.file);
    if (!existsSync(full)) { skippedMissing++; continue; }
    const buf = readFileSync(full);
    const dict = (decodeHeader(buf).flags & DICT_FLAG) !== 0 ? loadDictFor(dictDir, e.dictId) ?? undefined : undefined;
    const { rows } = decodeChunk(Buffer.from(buf), dict); // crc proof; throws on mismatch
    consulted.push(e.file);
    for (const r of rows) {
      if (hasSeq ? r.seq > (targetSeq as number) : r.ts > (targetTs as number)) continue;
      const cur = state.get(r.id);
      if (!cur || r.seq > cur.seq || (r.seq === cur.seq && r.ts > cur.ts)) state.set(r.id, r);
    }
  }
  const rows = [...state.values()].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (skippedMissing > 0) console.warn(`timetravel: ${skippedMissing} chunk(s) missing, result incomplete`);
  return { rows, proof: { chunksConsulted: consulted, chunksPruned: pruned, skippedMissing, manifestSource: source } };
}
