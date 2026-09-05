// Shared synthetic-log helpers for moltarc tests.
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export function scratch(name: string): string {
  // parallel workers share pid+clock: pid+Date.now alone collides, so add a
  // random suffix and retry on EEXIST instead of reusing a live dir.
  const base = `moltarc-${name}-${process.pid}`;
  for (let i = 0; i < 100; i++) {
    const dir = join(tmpdir(), `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    try {
      mkdirSync(dir);
      return dir;
    } catch { /* collision: retry with a fresh suffix */ }
  }
  throw new Error(`scratch: cannot allocate dir for ${name}`);
}

export interface GenOpts {
  rows: number;
  templates?: string[];
  table?: string;
  device?: string;
  uniqueBodies?: boolean;
  tsStepMs?: number;
}

// Repetitive POS-style log lines; ids zero-padded so chunk key ranges stay disjoint.
export function writeHotLog(dir: string, opts: GenOpts): { hotDb: string; inputBytes: number; ids: string[] } {
  const templates = opts.templates ?? [
    'TRANSACTION OK amount=15000 cashier=agus tend=cash change=0 store=jakarta-selatan',
    'TRANSACTION OK amount=25000 cashier=budi tend=qris change=0 store=jakarta-selatan',
    'STOCK UPDATE sku=INDOMIE-GORENG qty=48 shelf=A3 store=jakarta-selatan',
    'SHIFT OPEN cashier=agus float=500000 drawer=1 store=jakarta-selatan',
    'PAYMENT SETTLED method=qris batches=1 fee=700 store=jakarta-selatan',
  ];
  const table = opts.table ?? 'sales';
  const device = opts.device ?? 'pos-01';
  const base = 1_700_000_000_000;
  const lines: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < opts.rows; i++) {
    const id = `trx-${String(i + 1).padStart(8, '0')}`;
    ids.push(id);
    const body = opts.uniqueBodies ? `TRANSACTION seq=${i} ref=${((i * 2654435761) >>> 0).toString(16)} amount=${15000 + (i % 97)}` : templates[i % templates.length];
    lines.push(JSON.stringify({
      device_id: device, seq: i + 1, ts: base + i * (opts.tsStepMs ?? 1000),
      id, table, body,
    }));
  }
  const hotDb = join(dir, 'hot.jsonl');
  writeFileSync(hotDb, `${lines.join('\n')}\n`);
  return { hotDb, inputBytes: Buffer.byteLength(lines.join('\n')), ids };
}
