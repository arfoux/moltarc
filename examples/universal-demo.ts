// examples/universal-demo — 50 universal shop orders: seal -> ship -> find 1 order, print ratio.
// Usage: bun examples/universal-demo.ts [--out examples/out]
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { seal } from '../src/seal.js';
import { ship, readRelayIndex } from '../src/ship.js';
import { findTrx } from '../src/find.js';
import type { HotRow } from '../src/chunk.js';

export interface UniversalResult {
  hotDb: string;
  targetId: string;
  row: HotRow;
  chunk: string;
  inputBytes: number;
  warmBytes: number;
  ratio: number;
  shipped: number;
}

const HEAD = 'GREEN MART 42 MARKET ST ORDER:';
const TAIL = 'THANK YOU FOR SHOPPING WITH US';

export function writeOrders(dir: string, rows: number): { hotDb: string; ids: string[] } {
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
      device_id: 'pos-01', seq, ts: base + i * 30_000, id, table: 'events',
      body: `${HEAD} no=${1000 + i} value=${amt} tender=${i % 3 === 0 ? 'cash' : i % 3 === 1 ? 'card' : 'wallet'} clerk=alex ${TAIL}`,
    }));
  }
  const hotDb = join(dir, 'orders.jsonl');
  writeFileSync(hotDb, `${lines.join('\n')}\n`);
  return { hotDb, ids };
}

export async function runUniversalDemo(baseDir: string, rows = 50): Promise<UniversalResult> {
  mkdirSync(baseDir, { recursive: true });
  const { hotDb, ids } = writeOrders(baseDir, rows);
  const outDir = join(baseDir, 'archive');
  const relayDir = join(baseDir, 'relay');

  const sealed = await seal({ hotDb, outDir });
  console.log(`seal: ${sealed.rowsSealed} orders -> ${sealed.chunks.length} chunk(s)`);
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
  const out = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(dirname(fileURLToPath(import.meta.url)), 'universal-out');
  await runUniversalDemo(out);
  console.log('universal demo ok');
}

const invoked = (process.argv[1] ?? '').replace(/\\/g, '/');
if (invoked.endsWith('examples/universal-demo.ts') || invoked.endsWith('examples/universal-demo.js')) await main();
