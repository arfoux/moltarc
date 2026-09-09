// Shared synthetic-log helpers for moltarc tests.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { after } from 'node:test';
import { join } from 'path';
import { tmpdir } from 'os';

// Every scratch dir ever allocated by this process's tests; reaped by the
// file-level after() hook so Temp stops accumulating across suite runs.
const live = new Set<string>();
function reapAll(): void {
  for (const dir of live) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
  live.clear();
}
after(reapAll);
// after() is skipped when a test worker dies mid-suite (same flake class
// that drops a random test). process exit is sync-only but rmSync fits.
process.on('exit', reapAll);
// Opportunistic orphan sweep: dirs carry the creator pid
// (moltarc-<name>-<pid>-...); a dead pid means nobody will reap them.
// One candidate per scratch() call: amortized, contention-free, and never
// touches a live pid's dirs or this process's own live set.
function reapOneOrphan(): void {
  let entries: string[];
  try { entries = readdirSync(tmpdir()); } catch { return; }
  const here = tmpdir();
  for (const e of entries) {
    const m = /^moltarc-[A-Za-z0-9_-]+-(\d+)-/.exec(e);
    if (!m) continue;
    const full = join(here, e);
    let alive = true;
    try { process.kill(Number(m[1]), 0); } catch { alive = false; }
    // mtime guard: pid reuse on a busy box could point at an unrelated
    // newborn process; only reap what is both ownerless AND stale.
    let stale = false;
    try { stale = Date.now() - statSync(full).mtimeMs > 15 * 60 * 1000; } catch { continue; }
    if (!alive && stale) {
      try { rmSync(full, { recursive: true, force: true }); } catch { /* raced */ }
      return;
    }
  }
}

export function scratch(name: string): string {
  // parallel workers share pid+clock: pid+Date.now alone collides, so add a
  // random suffix and retry on EEXIST instead of reusing a live dir.
  reapOneOrphan();
  const base = `moltarc-${name}-${process.pid}`;
  for (let i = 0; i < 100; i++) {
    const dir = join(tmpdir(), `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    try {
      mkdirSync(dir);
      live.add(dir);
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

// Repetitive neutral event log lines; ids zero-padded so chunk key ranges stay disjoint.
export function writeHotLog(dir: string, opts: GenOpts): { hotDb: string; inputBytes: number; ids: string[] } {
  const templates = opts.templates ?? [
    'EVENT OK value=15000 operator=agus method=cash change=0 site=north-1',
    'EVENT OK value=25000 operator=budi method=card change=0 site=north-1',
    'TALLY UPDATE sku=WIDGET-01 qty=48 shelf=A3 site=north-1',
    'SHIFT OPEN operator=agus float=500000 drawer=1 site=north-1',
    'ENTRY RESOLVED method=card batches=1 fee=700 site=north-1',
  ];
  const table = opts.table ?? 'events';
  const device = opts.device ?? 'dev-01';
  const base = 1_700_000_000_000;
  const lines: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < opts.rows; i++) {
    const id = `trx-${String(i + 1).padStart(8, '0')}`;
    ids.push(id);
    const body = opts.uniqueBodies ? `EVENT seq=${i} ref=${((i * 2654435761) >>> 0).toString(16)} value=${15000 + (i % 97)}` : templates[i % templates.length];
    lines.push(JSON.stringify({
      device_id: device, seq: i + 1, ts: base + i * (opts.tsStepMs ?? 1000),
      id, table, body,
    }));
  }
  const hotDb = join(dir, 'hot.jsonl');
  writeFileSync(hotDb, `${lines.join('\n')}\n`);
  return { hotDb, inputBytes: Buffer.byteLength(lines.join('\n')), ids };
}
