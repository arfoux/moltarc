// moltarc concurrent writers: 3 real OS processes (Bun.spawn, one table per
// writer) share a single hot file with append+seal+ship interleaved. Appends
// and ships run fully concurrent; seals take a mkdir lockdir because the
// per-table chain rule needs non-overlapping seals (concurrent seals snapshot
// different row subsets and flush overlapping ranges, which no heal can
// untangle). End state after join + parent heal: no lost acked events (every
// appended id findable with exact body), no torn lines (hot parses clean),
// per-device watermark monotonic to exactly max acked seq with contiguous
// per-table coverage, and a consistent manifest (verifyFull clean, relay drained).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { clearFindCaches, findTrx } from '../src/find.js';
import { loadManifest } from '../src/manifest.js';
import { readHotRowsCounted, seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { verifyFull } from '../src/verify.js';
import { scratch } from './util.js';

const WORKERS = 3;
const ROWS = 120;
const SEAL_EVERY = 5;
const SHIP_EVERY = 15;
const TARGET = 8 * 1024; // small chunks: many seal/manifest races per run
const TS_BASE = 1_700_000_000_000;

const deviceOf = (w: number): string => `conc-${String(w).padStart(2, '0')}`;
const idOf = (device: string, seq: number): string => `${device}-${String(seq).padStart(6, '0')}`;
const bodyOf = (device: string, seq: number): string =>
  `concurrent ${device} seq=${seq} pad=${'x'.repeat(40 + (seq % 17))}`;

// Worker body runs in a fresh `bun -e` OS process: sync per-line appends
// (one write() each, so a concurrent seal sees whole lines or nothing),
// then periodic seal+ship against the same hot/outDir/relayDir. Seal
// retries ride out concurrent-seal races (shared watermark tmp rename,
// torn-scan quarantine) that always heal on the next seal.
function workerSource(root: string): string {
  const consts = `
const SEAL_EVERY = ${SEAL_EVERY};
const SHIP_EVERY = ${SHIP_EVERY};
const TARGET = ${TARGET};
const TS_BASE = ${TS_BASE};
const deviceOf = (w) => \`conc-\${String(w).padStart(2, '0')}\`;
const idOf = (device, seq) => \`\${device}-\${String(seq).padStart(6, '0')}\`;
const bodyOf = (device, seq) => \`concurrent \${device} seq=\${seq} pad=\${'x'.repeat(40 + (seq % 17))}\`;
`;
  return `
import { appendFileSync, mkdirSync, rmdirSync } from 'fs';
import { seal } from ${JSON.stringify(join(root, 'src/seal.ts'))};
import { ship } from ${JSON.stringify(join(root, 'src/ship.ts'))};
${consts}
const hot = process.env.HOT!;
const outDir = process.env.OUT!;
const relayDir = process.env.RELAY!;
const device = process.env.DEVICE!;
const rows = Number(process.env.ROWS);
const widx = Number(process.env.WIDX);
const lock = process.env.LOCK!;
async function sealLocked(): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try { mkdirSync(lock); break; }
    catch {
      if (Date.now() - t0 > 30000) throw new Error('seal lock timeout');
      await Bun.sleep(1 + Math.random() * 2);
    }
  }
  try { await seal({ hotDb: hot, outDir, targetBytes: TARGET }); }
  finally { try { rmdirSync(lock); } catch { /* holder crashed: next acquire times out loud */ } }
}
async function sealRetry(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    try { await sealLocked(); return; }
    catch (e) {
      if (i === 9) throw e;
      await Bun.sleep(2 + Math.random() * 8);
    }
  }
}
// Real delays: workers are live child OS processes racing the platform
// clock, so fake timers cannot drive them (same exception as worker-safety).
for (let s = 1; s <= rows; s++) {
  appendFileSync(hot, JSON.stringify({ device_id: device, seq: s, ts: TS_BASE + widx * 1000000 + s, id: idOf(device, s), table: device, body: bodyOf(device, s) }) + '\\n');
  if (s % SEAL_EVERY === 0) await sealRetry();
  if (s % SHIP_EVERY === 0) { try { await ship({ outDir, relayDir, baseDelayMs: 1 }); } catch { /* next ship heals */ } }
  if (s % 11 === 0) await Bun.sleep(Math.random() * 4);
}
await sealRetry();
try { await ship({ outDir, relayDir, baseDelayMs: 1 }); } catch { /* parent drains */ }
`;
}
describe('concurrent writers', () => {
  it('3 processes x append+seal+ship lose nothing and stay consistent', { timeout: 120_000 }, async () => {
    const dir = scratch('concurrent');
    const hot = join(dir, 'hot.jsonl');
    writeFileSync(hot, '');
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const devices = Array.from({ length: WORKERS }, (_, w) => deviceOf(w));

    const procs = devices.map((device, widx) =>
      Bun.spawn(['bun', '-e', workerSource(root)], {
        cwd: root,
        env: {
          ...process.env, HOT: hot, OUT: outDir, RELAY: relayDir, LOCK: join(dir, 'seal.lock'),
          DEVICE: device, ROWS: String(ROWS), WIDX: String(widx),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );

    // Real polling: witnesses live child progress against the platform
    // clock; fake timers cannot advance separate OS processes. Seals are
    // lock-serialized, so the watermark file must never regress mid-run.
    let sawPartial = false;
    const total = WORKERS * ROWS;
    const wmPath = join(outDir, 'sealed_upto_seq');
    const wmHigh: Record<string, number> = {};
    let wmRegressions = 0;
    const poll = setInterval(() => {
      try {
        const text = readFileSync(hot, 'utf8');
        if (text.length > 0) {
          const lines = text.split('\n').filter((l) => l.trim().length > 0).length;
          if (lines > 0 && lines < total) sawPartial = true;
        }
      } catch { /* hot not yet created: ignore */ }
      try {
        const wm = JSON.parse(readFileSync(wmPath, 'utf8')) as Record<string, number>;
        for (const [k, v] of Object.entries(wm)) {
          if ((wmHigh[k] ?? 0) > v) wmRegressions++;
          wmHigh[k] = Math.max(wmHigh[k] ?? 0, v);
        }
      } catch { /* watermark not yet persisted: ignore */ }
    }, 5);
    const codes = await Promise.all(procs.map((p) => p.exited));
    clearInterval(poll);
    for (let i = 0; i < procs.length; i++) {
      const err = (await new Response(procs[i].stderr).text()).trim();
      assert.equal(codes[i], 0, `worker ${devices[i]} exit=${codes[i]} stderr=${err.slice(-500)}`);
    }
    assert.equal(sawPartial, true, 'workers overlapped: hot observed mid-append');
    assert.equal(wmRegressions, 0, 'watermark never regresses mid-run');

    // Heal: drain every pending row and every unshipped chunk in the parent.
    for (let i = 0; i < 10; i++) {
      const r = await seal({ hotDb: hot, outDir, targetBytes: TARGET });
      if (r.rowsSealed === 0) break;
    }
    for (let i = 0; i < 10; i++) {
      const r = await ship({ outDir, relayDir, baseDelayMs: 1 });
      if (r.sent.length === 0) break;
    }
    clearFindCaches();

    // Framing intact: every hot line parses, zero malformed, exact row count.
    const counted = readHotRowsCounted(hot);
    assert.equal(counted.malformed, 0, 'no torn lines in shared hot');
    assert.equal(counted.rows.length, total, 'hot holds every appended row');
    const hotIds = new Set(counted.rows.map((r) => r.id));
    for (const device of devices) {
      for (let s = 1; s <= ROWS; s++) assert.ok(hotIds.has(idOf(device, s)), `hot missing ${idOf(device, s)}`);
    }

    // No lost acked events: every appended id resolves with its exact body.
    for (const device of devices) {
      for (let s = 1; s <= ROWS; s++) {
        const id = idOf(device, s);
        let row: { id: string; body: string };
        try {
          row = findTrx({ outDir, trxId: id }).row;
        } catch (e) {
          assert.fail(`lost acked event ${id}: ${(e as Error).message}`);
        }
        assert.equal(row.id, id);
        assert.equal(row.body, bodyOf(device, s), `torn content for ${id}`);
      }
    }

    // Watermark monotonic per device: exactly max acked seq, never beyond.
    const wm = JSON.parse(readFileSync(join(outDir, 'sealed_upto_seq'), 'utf8')) as Record<string, number>;
    assert.deepEqual(Object.keys(wm).sort(), [...devices].sort(), 'watermark tracks every device');
    for (const device of devices) assert.equal(wm[device], ROWS, `watermark ${device} at max acked seq`);

    // Manifest consistent: per-table ranges tile 1..ROWS with no gap or
    // overlap, row counts exact, verifyFull clean, relay drained.
    const { manifest } = loadManifest(outDir);
    const live = manifest.chunks.filter((e) => !e.quarantined);
    assert.equal(live.length > 0, true, 'manifest lists chunks');
    for (const device of devices) {
      const ranges = live
        .filter((e) => e.table === device)
        .map((e) => ({ min: e.seqMin, max: e.seqMax, rows: e.rows }))
        .sort((a, b) => a.min - b.min);
      assert.equal(ranges.length > 0, true, `table ${device} has chunks`);
      let next = 1;
      let rows = 0;
      for (const r of ranges) {
        assert.equal(r.min, next, `table ${device}: gap/overlap at seq ${next}`);
        next = r.max + 1;
        rows += r.rows;
      }
      assert.equal(next - 1, ROWS, `table ${device} covers 1..${ROWS}`);
      assert.equal(rows, ROWS, `table ${device} seals ${ROWS} rows exactly once`);
    }
    const full = verifyFull(outDir);
    assert.equal(full.ok, true, `verifyFull clean: ${JSON.stringify(full.bad)} chain=${JSON.stringify(full.chain)}`);
    for (const e of live) {
      assert.ok(existsSync(join(relayDir, 'chunks', e.file)), `relay holds ${e.file}`);
    }
  });
});
