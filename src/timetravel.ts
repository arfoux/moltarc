// moltarc timetravel — read-only state as-of (seq | ts).
// Fold order is seqMin ascending; latest row per id with seq/ts <= target wins.
// Read-only: loadManifest + readFileSync + decodeChunk (crc proof inside).
// Any crc mismatch throws before folding (stop on base-proof mismatch).
// Reuses the findTrx single-chunk fetch pattern via imports only.
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
  const kept = [];
  let pruned = 0;
  for (const e of manifest.chunks) {
    if (e.quarantined) { pruned++; continue; }
    const lo = hasSeq ? e.seqMin : e.tsMin;
    if (lo > (hasSeq ? (targetSeq as number) : (targetTs as number))) { pruned++; continue; }
    kept.push(e);
  }
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
  return { rows, proof: { chunksConsulted: consulted, chunksPruned: pruned, skippedMissing, manifestSource: source } };
}
