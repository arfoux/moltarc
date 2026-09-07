// bench/perf — seal MB/s, ship delta-vs-full ratio, find single-chunk latency.
// All numbers are measured on this machine; this script prints them and
// records them into bench/measured.json under the "perf" key.
// Usage: bun bench/perf.ts [--rows 6000] [--seed 7] [--out bench/perf-out] [--find-iters 20]
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { arch, cpus, platform, release } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { findTrx } from '../src/find.js';
import { generateMixedCorpus, recordMeasured } from './mixed-corpus.js';

export interface PerfMeasure {
  rows: number;
  seed: number;
  inputBytes: number;
  warmBytes: number;
  chunks: number;
  mixedRatio: number;
  sealMs: number;
  sealMBs: number;
  fullShipBytes: number;
  fullShipChunks: number;
  deltaRows: number;
  deltaShipBytes: number;
  deltaShipChunks: number;
  deltaVsFull: number;
  findId: string;
  findIters: number;
  findMedianMs: number;
  findP50Ms: number;
  findP99Ms: number;
  findIds: string[];
  findColdMs: number;
  findFetched: number;
  findPruned: number;
  machine: string;
}
export const FIND_ID_COUNT = 6;

function warmBytesOf(outDir: string): { bytes: number; chunks: number } {
  const warm = join(outDir, 'warm');
  const files = readdirSync(warm).filter((f: string) => f.endsWith('.chk'));
  return { bytes: files.reduce((n, f) => n + statSync(join(warm, f)).size, 0), chunks: files.length };
}

function machineSpec(): string {
  const cpu = cpus()[0]?.model.trim() ?? 'unknown-cpu';
  return `${platform()} ${release()} ${arch()} | ${cpu} x${cpus().length} | bun ${Bun.version}`;
}

function median(xs: number[]): number {
  return percentile(xs, 50);
}
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([^=]+)(=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    if (m[3] !== undefined) out[m[1]] = m[3];
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[m[1]] = argv[++i];
    else out[m[1]] = '1';
  }
  return out;
}

export async function measurePerf(dir: string, rows: number, seed: number, findIters: number): Promise<PerfMeasure> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const corpus = generateMixedCorpus(dir, rows, seed);
  const outDir = join(dir, 'arch');
  const inputBytes = statSync(corpus.mixedPath).size;

  const t0 = performance.now();
  await seal({ hotDb: corpus.mixedPath, outDir });
  const sealMs = performance.now() - t0;
  const warm = warmBytesOf(outDir);

  const relay = join(dir, 'relay');
  const full = await ship({ outDir, relayDir: relay });
  const fullShipBytes = full.bytes;

  // Delta: append 10% new rows (new seqs, new ids), reseal, ship again to same relay.
  const deltaRows = Math.max(1, Math.round(rows / 10));
  const base = 1_700_000_000_000 + rows * 1000;
  const extra: string[] = [];
  for (let k = 1; k <= deltaRows; k++) {
    const seq = rows + k;
    extra.push(JSON.stringify({
      device_id: 'pos-01', seq, ts: base + k * 1000,
      id: `trx-${String(seq).padStart(8, '0')}`, table: 'sales',
      body: `delta row ${seq} appended after full ship`,
    }));
  }
  appendFileSync(corpus.mixedPath, `${extra.join('\n')}\n`);
  await seal({ hotDb: corpus.mixedPath, outDir });
  const delta = await ship({ outDir, relayDir: relay });

  // Spread ids across the corpus so p50/p99 covers early/late chunks, not one
  // lucky chunk. The first lookup of each id is cold (manifest/dict caches
  // miss); the timed samples after it are warm.
  const findIds = Array.from({ length: FIND_ID_COUNT }, (_, k) =>
    `trx-${String(Math.floor((rows * (k + 1)) / (FIND_ID_COUNT + 1))).padStart(8, '0')}`);
  const findId = findIds[Math.floor(findIds.length / 3)];
  const cold: number[] = [];
  const samples: number[] = [];
  let findFetched = 0;
  let findPruned = 0;
  for (const id of findIds) {
    const t0 = performance.now();
    const probe = findTrx({ outDir, trxId: id });
    cold.push(performance.now() - t0);
    findFetched += probe.chunksFetched;
    findPruned += probe.chunksPruned;
    for (let i = 0; i < findIters; i++) {
      const t = performance.now();
      findTrx({ outDir, trxId: id });
      samples.push(performance.now() - t);
    }
  }

  return {
    rows, seed, inputBytes,
    warmBytes: warm.bytes, chunks: warm.chunks,
    mixedRatio: warm.bytes > 0 ? inputBytes / warm.bytes : 0,
    sealMs, sealMBs: inputBytes / 1048576 / (sealMs / 1000),
    fullShipBytes, fullShipChunks: full.sent.length,
    deltaRows, deltaShipBytes: delta.bytes, deltaShipChunks: delta.sent.length,
    deltaVsFull: fullShipBytes > 0 ? delta.bytes / fullShipBytes : 0,
    findId, findIters, findMedianMs: median(samples),
    findP50Ms: percentile(samples, 50), findP99Ms: percentile(samples, 99),
    findIds, findColdMs: median(cold),
    findFetched, findPruned,
    machine: machineSpec(),
  };
}

async function main(): Promise<void> {
  const a = args();
  const rows = Number(a.rows ?? '6000');
  const seed = Number(a.seed ?? '7');
  const findIters = Number(a['find-iters'] ?? '20');
  const here = dirname(fileURLToPath(import.meta.url));
  const out = a.out ?? join(here, 'perf-out');
  const p = await measurePerf(out, rows, seed, findIters);
  console.log(`seal: input=${p.inputBytes}B warm=${p.warmBytes}B ratio=${p.mixedRatio.toFixed(1)}x chunks=${p.chunks} time=${p.sealMs.toFixed(0)}ms rate=${p.sealMBs.toFixed(1)}MB/s`);
  console.log(`ship: full=${p.fullShipBytes}B in ${p.fullShipChunks} chunk(s), delta(${p.deltaRows} rows)=${p.deltaShipBytes}B in ${p.deltaShipChunks} chunk(s), delta/full=${p.deltaVsFull.toFixed(3)}`);
  console.log(`find: ${p.findIds.length} ids x${p.findIters} iters cold-median=${p.findColdMs.toFixed(2)}ms warm p50=${p.findP50Ms.toFixed(2)}ms p99=${p.findP99Ms.toFixed(2)}ms (fetched=${p.findFetched} pruned=${p.findPruned})`);
  console.log('find note: first lookup per id is cold (manifest/dict cache miss); p50/p99 pool warm lookups only');
  console.log(`machine: ${p.machine}`);
  recordMeasured(here, 'perf', {
    rows: p.rows, seed: p.seed,
    inputBytes: p.inputBytes, warmBytes: p.warmBytes, chunks: p.chunks,
    mixedRatio: p.mixedRatio.toFixed(1),
    sealMs: Math.round(p.sealMs), sealMBs: p.sealMBs.toFixed(1),
    fullShipBytes: p.fullShipBytes, fullShipChunks: p.fullShipChunks,
    deltaRows: p.deltaRows, deltaShipBytes: p.deltaShipBytes,
    deltaShipChunks: p.deltaShipChunks, deltaVsFull: p.deltaVsFull.toFixed(3),
    findId: p.findId, findIds: p.findIds.join(','), findIters: p.findIters,
    findMedianMs: p.findMedianMs.toFixed(2),
    findP50Ms: p.findP50Ms.toFixed(2), findP99Ms: p.findP99Ms.toFixed(2),
    findColdMs: p.findColdMs.toFixed(2),
    findNote: 'first lookup per id is cold (manifest/dict cache miss); p50/p99 pool warm lookups only',
    findFetched: p.findFetched, findPruned: p.findPruned,
    machine: p.machine,
  });
}

const invoked = (process.argv[1] ?? '').replace(/\\/g, '/');
if (invoked.endsWith('bench/perf.ts') || invoked.endsWith('bench/perf.js')) await main();
