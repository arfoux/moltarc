// examples/kasir-demo — 50 cashier receipts: seal -> ship -> find 1 receipt, print ratio.
// Usage: bun examples/kasir-demo.ts [--out examples/out]
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { seal } from '../src/seal.js';
import { ship, readRelayIndex } from '../src/ship.js';
import { findTrx } from '../src/find.js';
import type { HotRow } from '../src/chunk.js';

export interface KasirResult {
  hotDb: string;
  targetId: string;
  row: HotRow;
  chunk: string;
  inputBytes: number;
  warmBytes: number;
  ratio: number;
  shipped: number;
}

const HEAD = 'TOKO SUMBER MAKMUR JL RAYA BOGOR KM 42 STRUK:';
const TAIL = 'TERIMA KASIH SUDAH BERBELANJA';

export function writeStruk(dir: string, rows: number): { hotDb: string; ids: string[] } {
  mkdirSync(dir, { recursive: true });
  const base = 1_700_000_000_000;
  const lines: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < rows; i++) {
    const seq = i + 1;
    const id = `trx-${String(seq).padStart(8, '0')}`;
    ids.push(id);
    const amt = 5000 + ((i * 37) % 20) * 10000;
    lines.push(JSON.stringify({
      device_id: 'kasir-01', seq, ts: base + i * 30_000, id, table: 'sales',
      body: `${HEAD} no=${1000 + i} amount=${amt} tend=${i % 3 === 0 ? 'cash' : 'qris'} kasir=agus ${TAIL}`,
    }));
  }
  const hotDb = join(dir, 'kasir.jsonl');
  writeFileSync(hotDb, `${lines.join('\n')}\n`);
  return { hotDb, ids };
}

export async function runKasirDemo(baseDir: string, rows = 50): Promise<KasirResult> {
  mkdirSync(baseDir, { recursive: true });
  const { hotDb, ids } = writeStruk(baseDir, rows);
  const outDir = join(baseDir, 'archive');
  const relayDir = join(baseDir, 'relay');

  const sealed = await seal({ hotDb, outDir });
  console.log(`seal: ${sealed.rowsSealed} receipts -> ${sealed.chunks.length} chunk(s)`);
  const shipped = await ship({ outDir, relayDir, baseDelayMs: 1 });
  console.log(`ship: sent ${shipped.sent.length} chunk(s), relay holds ${Object.keys(readRelayIndex(relayDir).chunks).length}`);

  const targetId = ids[Math.floor(ids.length / 2)];
  const found = findTrx({ outDir, trxId: targetId });
  console.log(`find: ${targetId} -> ${found.chunk} "${found.row.body.slice(0, 60)}..."`);

  const inputBytes = statSync(hotDb).size;
  const warmBytes = readdirSync(join(outDir, 'warm'))
    .filter((f: string) => f.endsWith('.chk'))
    .reduce((n: number, f: string) => n + statSync(join(outDir, 'warm', f)).size, 0);
  const ratio = inputBytes / warmBytes;
  console.log(`ratio: ${inputBytes}B -> ${warmBytes}B = ${ratio.toFixed(1)}x`);
  return { hotDb, targetId, row: found.row, chunk: found.chunk, inputBytes, warmBytes, ratio, shipped: shipped.sent.length };
}

async function main(): Promise<void> {
  const out = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(dirname(fileURLToPath(import.meta.url)), 'kasir-out');
  await runKasirDemo(out);
  console.log('cashier demo ok');
}

const invoked = (process.argv[1] ?? '').replace(/\\/g, '/');
if (invoked.endsWith('examples/kasir-demo.ts') || invoked.endsWith('examples/kasir-demo.js')) await main();
