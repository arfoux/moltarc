// examples/dashboard — timetravel polling demo: seal rows, poll recent-state N times.
// Usage: bun examples/dashboard.ts [--out <dir>] [--iters 3] [--interval-ms 500] [--window-ms 3600000]
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { seal } from '../src/seal.js';
import { queryAsOf } from '../src/timetravel.js';

export interface DashboardResult {
  iters: number;
  lastRows: number;
  lastConsulted: number;
  windowed: boolean;
}

export function writeDashLog(dir: string, rows: number): string {
  mkdirSync(dir, { recursive: true });
  const base = Date.now() - rows * 1000;
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) {
    const seq = i + 1;
    lines.push(JSON.stringify({
      device_id: 'cashier-01', seq, ts: base + i * 1000,
      id: `trx-${String(seq).padStart(8, '0')}`, table: 'events',
      body: `DASH sale seq=${seq} value=${5000 + (i % 20) * 1000}`,
    }));
  }
  const hotDb = join(dir, 'dash.jsonl');
  writeFileSync(hotDb, `${lines.join('\n')}\n`);
  return hotDb;
}

export async function runDashboard(baseDir: string, iters = 3, intervalMs = 200, windowMs = 3600000): Promise<DashboardResult> {
  mkdirSync(baseDir, { recursive: true });
  const hotDb = writeDashLog(baseDir, 300);
  const outDir = join(baseDir, 'archive');
  const sealed = await seal({ hotDb, outDir });
  console.log(`seal: ${sealed.rowsSealed} rows -> ${sealed.chunks.length} chunk(s)`);
  let lastRows = 0;
  let lastConsulted = 0;
  let windowed = false;
  for (let i = 0; i < iters; i++) {
    const r = queryAsOf({ outDir, ts: Date.now(), windowMs });
    lastRows = r.rows.length;
    lastConsulted = r.proof.chunksConsulted.length;
    windowed = r.proof.windowed;
    console.log(`poll ${i + 1}/${iters}: rows=${lastRows} consulted=${lastConsulted} pruned=${r.proof.chunksPruned} windowed=${windowed}`);
    if (i + 1 < iters) await new Promise<void>((r2) => setTimeout(r2, intervalMs));
  }
  return { iters, lastRows, lastConsulted, windowed };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
    return fallback;
  };
  const out = get('out', join(dirname(fileURLToPath(import.meta.url)), 'dash-out'));
  const r = await runDashboard(out, Number(get('iters', '3')), Number(get('interval-ms', '200')), Number(get('window-ms', '3600000')));
  console.log(`dashboard ok: ${r.iters} polls, last rows=${r.lastRows}`);
}

const invoked = (process.argv[1] ?? '').replace(/\\/g, '/');
if (invoked.endsWith('examples/dashboard.ts') || invoked.endsWith('examples/dashboard.js')) await main();
