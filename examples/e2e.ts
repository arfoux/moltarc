// examples/e2e — feed JSONL -> seal -> ship to relay dir -> find one trx.
// Usage: bun examples/e2e.ts [--out /tmp/moltarc-e2e]
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { seal } from '../src/seal.js';
import { ship, readRelayIndex } from '../src/ship.js';
import { findTrx } from '../src/find.js';
import type { HotRow } from '../src/chunk.js';

export interface E2EResult {
  hotDb: string;
  targetId: string;
  row: HotRow;
  chunk: string;
  chunksFetched: number;
  shipped: number;
  relayChunks: number;
}

// Field sensors + operator activity, zero-padded ids for range prune.
export function writeFeed(dir: string, rows: number): { hotDb: string; ids: string[] } {
  mkdirSync(dir, { recursive: true });
  const plots = ['plot-1', 'plot-2', 'plot-3', 'plot-4'];
  const lines: string[] = [];
  const ids: string[] = [];
  const base = 1_700_000_000_000;
  for (let i = 0; i < rows; i++) {
    const seq = i + 1;
    const id = `trx-${String(seq).padStart(8, '0')}`;
    ids.push(id);
    const plot = plots[i % plots.length];
    const table = i % 10 === 9 ? 'activity' : 'reading';
    const body = table === 'reading'
      ? `FIELD READING plot=${plot} temp=${24 + (i % 9)}C humidity=${70 + (i % 21)}% ph=6.${3 + (i % 5)} water=wet sensor=device-01`
      : `FIELD ACTIVITY plot=${plot} task=${['plant', 'cut', 'fertilize', 'spray', 'harvest'][i % 5]} actor=${['warto', 'siti', 'dadang'][i % 3]}`;
    lines.push(JSON.stringify({
      device_id: i % 2 ? 'device-01' : 'device-02',
      seq, ts: base + i * 60_000, id, table, body,
    }));
  }
  const hotDb = join(dir, 'feed.jsonl');
  writeFileSync(hotDb, `${lines.join('\n')}\n`);
  return { hotDb, ids };
}

export async function runE2E(baseDir: string, rows = 1200): Promise<E2EResult> {
  mkdirSync(baseDir, { recursive: true });
  const { hotDb, ids } = writeFeed(baseDir, rows);
  const outDir = join(baseDir, 'archive');
  const relayDir = join(baseDir, 'relay');

  const sealed = await seal({ hotDb, outDir });
  console.log(`seal: ${sealed.rowsSealed} rows -> ${sealed.chunks.length} chunk(s), sealed_upto_seq=${sealed.sealedUptoSeq}`);
  const shipped = await ship({ outDir, relayDir, baseDelayMs: 1 });
  const relayChunks = Object.keys(readRelayIndex(relayDir).chunks).length;
  console.log(`ship: sent ${shipped.sent.length} chunk(s), relay holds ${relayChunks}`);

  const targetId = ids[Math.floor(ids.length / 2)];
  const found = findTrx({ outDir, trxId: targetId });
  console.log(`find: ${targetId} -> chunk ${found.chunk} (fetched ${found.chunksFetched}) body="${found.row.body.slice(0, 80)}..."`);
  return {
    hotDb, targetId, row: found.row, chunk: found.chunk,
    chunksFetched: found.chunksFetched, shipped: shipped.sent.length, relayChunks,
  };
}

async function main(): Promise<void> {
  const out = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(dirname(fileURLToPath(import.meta.url)), 'e2e-out');
  await runE2E(out);
  console.log('e2e ok');
}

const invoked = (process.argv[1] ?? '').replace(/\\/g, '/');
if (invoked.endsWith('examples/e2e.ts') || invoked.endsWith('examples/e2e.js')) await main();
