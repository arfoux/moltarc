// moltarc sqlite extension — typescript reference surface.
//
// SQL scalar contract (mirrored by ext/moltarc.c for stock sqlite3):
//   moltarc_find(outDir TEXT, trxId TEXT) -> TEXT | NULL   (read-only)
//   moltarc_seal(hotDb TEXT, outDir TEXT[, table TEXT]) -> TEXT
//
// Reuse rule: everything chunk-format goes through src/seal.ts + src/find.ts
// via import. Zero chunk bytes are parsed here, so this file can never fork
// the format. The C extension must do the same (link the canonical reader,
// never reimplement the codec).
import { seal } from '../src/seal.js';
import { findTrx } from '../src/find.js';

export const FIND_NAME = 'moltarc_find';
export const FIND_ARITY = 2;
export const SEAL_NAME = 'moltarc_seal';

export interface MoltarcRowJson {
  id: string;
  table: string;
  device_id: string;
  seq: number;
  ts: number;
  body: string;
  chunk: string;
}

// Read-only: findTrx touches manifest + one warm chunk, writes nothing.
// Miss (or corrupt-index error) maps to SQL NULL, never to an exception
// crossing the sqlite value boundary.
export function moltarcFind(outDir: string, trxId: string): string | null {
  try {
    const r = findTrx({ outDir, trxId });
    const row: MoltarcRowJson = {
      id: r.row.id,
      table: r.row.table,
      device_id: r.row.device_id,
      seq: r.row.seq,
      ts: r.row.ts,
      body: r.row.body,
      chunk: r.chunk,
    };
    return JSON.stringify(row);
  } catch {
    return null;
  }
}

// Trivially safe: seal() never deletes input, re-seal is idempotent via the
// per-device sealed_upto_seq watermark, and it refuses before any write when
// free space drops below the reserve. Returns the SealResult as JSON text.
export async function moltarcSeal(hotDb: string, outDir: string, table = 'log'): Promise<string> {
  const r = await seal({ hotDb, outDir, table });
  return JSON.stringify(r);
}

// Subprocess reuse: any sqlite host without a compiled extension can back the
// SQL functions with these entry points, e.g.
//   bun ext/moltarc.ts find <outDir> <trxId>   -> row json on stdout, exit 1 on miss
//   bun ext/moltarc.ts seal <hotDb> <outDir> [table] -> seal-result json on stdout
const invoked = process.argv[1]?.replace(/\\/g, '/').endsWith('ext/moltarc.ts') ?? false;
if (invoked) {
  const [, , cmd, a, b, c] = process.argv;
  if (cmd === 'find' && a !== undefined && b !== undefined) {
    const out = moltarcFind(a, b);
    if (out === null) process.exit(1);
    console.log(out);
  } else if (cmd === 'seal' && a !== undefined && b !== undefined) {
    moltarcSeal(a, b, c ?? 'log')
      .then((out) => console.log(out))
      .catch((e: unknown) => {
        console.error(String(e));
        process.exit(1);
      });
  } else {
    console.error('usage: moltarc.ts find <outDir> <trxId> | seal <hotDb> <outDir> [table]');
    process.exit(2);
  }
}
