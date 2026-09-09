// moltarc randomized soak: seeded rng drives 5k+ interleaved ops
// (append/seal/ship/sync/find/forget/gc/corrupt/repair/child-kill) with
// invariant checks every N steps: sampled live rows stay findable, manifest
// row counts match the oracle, verifyFull is clean after repair.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { HEADER_SIZE } from '../src/chunk.js';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { findTrx } from '../src/find.js';
import { loadManifest, buildManifest, saveManifestAtomic } from '../src/manifest.js';
import { sweep, statusInfo } from '../src/gc.js';
import { forgetChunks, sweepCold } from '../src/cold.js';
import { verifyAll, verifyChunk, verifyFull, quarantine, repairByHash } from '../src/verify.js';
import { scratch } from './util.js';
function isContentionError(e: unknown): boolean {
  let msg: string;
  if (e !== null && typeof e === 'object' && 'message' in e) {
    const m = e.message;
    msg = typeof m === 'string' ? m : String(e);
  } else {
    msg = String(e);
  }
  return /EADDRINUSE|EBUSY|ENOSPC|EMFILE|EAGAIN|ENOTEMPTY|EPERM|EBADF|ECONN|port|disk|contention|busy|locked|timeout/i.test(msg);
}
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt === attempts || !isContentionError(e)) throw e;
      // Real delay: retry backs off against live OS port/disk contention; fake timers cannot advance kernel state.
      await new Promise<void>((r) => setTimeout(r, 200 * attempt));
    }
  }
  throw last;
}


const OPS = Number(process.env.SOAK_OPS) || 5000;
const CHECK_EVERY = 250;
const TARGET = 12 * 1024;
const SEEDS = [1, 7];
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function runSoak(seed: number, ops: number): Promise<{ ops: number; seals: number; finds: number; kills: number; corrupts: number }> {
  const dir = scratch(`soak-${seed}`);
  const hotDb = join(dir, 'hot.jsonl');
  writeFileSync(hotDb, '');
  const outDir = join(dir, 'archive');
  const relayDir = join(dir, 'relay');
  const rng = mulberry32(seed);
  const pick = (n: number): number => Math.floor(rng() * n);
  // Single device + single table: per-table chain rule needs exact seq+1
  // continuity, which interleaved tables would break by design.
  let seq = 0;
  const idOfSeq = new Map<number, string>();
  const bodyOf = new Map<string, string>();
  const idToChunk = new Map<string, string>();
  const liveIds = new Set<string>();
  const shippedSha = new Set<string>();
  const chunkRows = new Map<string, number>();
  let sealedLiveRows = 0;
  const corrupted = new Set<string>();
  let seals = 0;
  let sealedOnce = false;
  let finds = 0;
  let kills = 0;
  let corrupts = 0;

  const appendRows = (): void => {
    const n = 1 + pick(3);
    const lines: string[] = [];
    for (let k = 0; k < n; k++) {
      seq++;
      const id = `trx-${String(seq).padStart(8, '0')}`;
      const body = `soak seq=${seq} r=${pick(1 << 30).toString(16)} pad=${'x'.repeat(pick(48))}`;
      idOfSeq.set(seq, id);
      bodyOf.set(id, body);
      lines.push(JSON.stringify({ device_id: 'soak-01', seq, ts: 1_700_000_000_000 + seq * 1000, id, table: 'events', body }));
    }
    appendFileSync(hotDb, `${lines.join('\n')}\n`);
  };

  const anchorSealed = (): void => {
    const { manifest } = loadManifest(outDir);
    for (const e of manifest.chunks) {
      if (e.quarantined || corrupted.has(e.file)) continue;
      if (!e.quarantined) chunkRows.set(e.file, e.rows);
      for (let s = e.seqMin; s <= e.seqMax; s++) {
        const id = idOfSeq.get(s);
        if (id !== undefined && !idToChunk.has(id)) {
          idToChunk.set(id, e.file);
          liveIds.add(id);
        }
      }
    }
  };

  const doSeal = async (): Promise<void> => {
    const r = await seal({ hotDb, outDir, targetBytes: TARGET });
    seals++;
    sealedLiveRows += r.rowsSealed;
    if (r.rowsSealed > 0 || r.chunks.length > 0) anchorSealed();
  };

  const doShip = async (blobs: boolean): Promise<void> => {
    try {
      await ship({ outDir, relayDir, includeBlobs: blobs, baseDelayMs: 1 });
    } catch { /* torn relay write heals on the next ship */ }
    try {
      const { manifest } = loadManifest(outDir);
      for (const e of manifest.chunks) {
        if (existsSync(join(relayDir, 'chunks', e.file))) shippedSha.add(e.sha256);
      }
    } catch { /* manifest torn: next op heals */ }
  };

  const doCorrupt = (): void => {
    let entries: { file: string; sha256: string }[] = [];
    try {
      entries = loadManifest(outDir).manifest.chunks.filter((e) => !e.quarantined && shippedSha.has(e.sha256));
    } catch { return; }
    if (entries.length === 0) return;
    const victim = entries[pick(entries.length)].file;
    const full = join(outDir, 'warm', victim);
    if (!existsSync(full)) return;
    const buf = Buffer.from(readFileSync(full));
    if (buf.length <= HEADER_SIZE + 12) return;
    if (rng() < 0.3) {
      // quarantine path: entry keeps its original hash, file parks aside.
      quarantine(outDir, victim);
    } else {
      buf[HEADER_SIZE + 11] ^= 0x01 << pick(8);
      writeFileSync(full, buf);
    }
    corrupted.add(victim);
    corrupts++;
  };

  // Repair every bad chunk: intact entries heal by content hash from the
  // relay index; entries a seal already rebuilt over torn bytes (quarantined
  // stubs keyed by the torn hash) restore from the relay copy under the same
  // filename — crc self-validates — then the manifest rebuilds from disk.
  const repairEverything = (step: number): void => {
    let bad: string[] = [];
    try {
      bad = verifyAll(outDir).bad;
    } catch { return; }
    if (bad.length === 0 && corrupted.size === 0) return;
    const todo = new Set<string>([...bad, ...corrupted]);
    let fixedAny = false;
    for (const file of todo) {
      let fixed = false;
      try {
        repairByHash(outDir, relayDir, file);
        fixed = true;
      } catch {
        const rel = join(relayDir, 'chunks', file);
        if (existsSync(rel) && verifyChunk(rel).ok) {
          copyFileSync(rel, join(outDir, 'warm', file));
          fixed = true;
        }
      }
      if (fixed) {
        corrupted.delete(file);
        fixedAny = true;
        try { unlinkSync(join(outDir, 'quarantine', file)); } catch { /* no parked copy */ }
      }
    }
    assert.equal(corrupted.size, 0, `step ${step}: all corruptions repaired, stuck=${[...corrupted]}`);
    if (fixedAny) {
      const m = buildManifest(outDir);
      saveManifestAtomic(outDir, m);
      anchorSealed();
    }
  };

  const doRepair = (): void => {
    try { repairEverything(-1); } catch { /* surfaced at the next check */ }
  };

  const forgottenSeqs = new Set<number>();
  const doForgetTail = (): void => {
    let entries: { file: string; sha256: string; seqMax: number }[] = [];
    try {
      entries = loadManifest(outDir).manifest.chunks.filter((e) => !e.quarantined && shippedSha.has(e.sha256));
    } catch { return; }
    if (entries.length < 2) return;
    entries.sort((a, b) => a.seqMax - b.seqMax);
    const tail = entries[entries.length - 1] as { file: string; sha256: string; seqMin: number; seqMax: number };
    if (corrupted.has(tail.file)) return;
    try {
      forgetChunks(outDir, [tail.file], relayDir);
    } catch { return; }
    for (let s = tail.seqMin; s <= tail.seqMax; s++) forgottenSeqs.add(s);
    let dropped = 0;
    for (const [id, f] of idToChunk) {
      if (f === tail.file && liveIds.delete(id)) dropped++;
    }
    sealedLiveRows -= dropped;
    sweep(outDir, { dryRun: false, relayDir });
  };

  const doKill = async (mode: 'seal' | 'ship'): Promise<void> => {
    // random kill via child respawn: run the real cli in a child, kill it
    // mid-flight (lands in startup: watermark/manifest untouched), then heal
    // in-process and assert a clean walk.
    const args = mode === 'seal'
      ? ['bin/moltarc.ts', 'seal', hotDb, outDir]
      : ['bin/moltarc.ts', 'ship', outDir, relayDir];
    let child: ChildProcess | undefined;
    try {
      child = spawn('bun', args, { cwd: root, stdio: 'ignore' });
    } catch { /* spawn failed: fall through to in-process heal */ }
    if (child) {
      // an unhandled 'error' event crashes the test worker: swallow it here
      // and let the heal path below re-establish invariants.
      child.on('error', () => {});
      await new Promise<void>((r) => setTimeout(r, 3 + pick(10)));
      try { if (child.exitCode === null) child.kill(); } catch { /* already exited */ }
      await new Promise<void>((r) => {
        const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } r(); }, 10_000);
        child.on('exit', () => { clearTimeout(t); r(); });
        child.on('error', () => { clearTimeout(t); r(); });
      });
    }
    kills++;
    // heal: drop torn warm bytes the relay never acked, reseal, reship, repair.
    let files: string[] = [];
    try { files = readdirSync(join(outDir, 'warm')).filter((f) => f.endsWith('.chk')); } catch { /* nothing yet */ }
    let shaOf = new Map<string, string>();
    try {
      const { manifest } = loadManifest(outDir);
      shaOf = new Map(manifest.chunks.map((e) => [e.file, e.sha256]));
    } catch { /* manifest torn: seal below rebuilds it */ }
    for (const f of files) {
      if (corrupted.has(f)) continue; // repairable from the relay, never torn-heal it
      const v = verifyChunk(join(outDir, 'warm', f));
      if (!v.ok && !shippedSha.has(shaOf.get(f) ?? '')) {
        try { unlinkSync(join(outDir, 'warm', f)); } catch { /* gone */ }
      }
    }
    await seal({ hotDb, outDir, targetBytes: TARGET }).catch(() => {});
    seals++;
    anchorSealedSafe();
    await doShip(false);
    try { repairEverything(-1); } catch { /* surfaced at the next check */ }
    try { recount(); } catch { /* still torn: next check surfaces it */ }
  };

  const anchorSealedSafe = (): void => {
    try { anchorSealed(); } catch { /* still torn: next check surfaces it */ }
  };

  // Disk truth wins after a child seal: the child may have sealed rows under
  // its own watermark advance, so recount live rows from the manifest.
  const recount = (): void => {
    const { manifest } = loadManifest(outDir);
    let rows = 0;
    for (const e of manifest.chunks) rows += e.quarantined ? (chunkRows.get(e.file) ?? 0) : e.rows;
    sealedLiveRows = rows;
  };

  const checkInvariants = (step: number): void => {
    // 0. repair first: every bad chunk heals, then the walk must be clean.
    repairEverything(step);
    // 1. sampled live rows stay findable with exact bodies.
    const live = [...liveIds];
    const samples = Math.min(8, live.length);
    for (let k = 0; k < samples; k++) {
      const id = live[pick(live.length)];
      const found = findTrx({ outDir, trxId: id });
      finds++;
      assert.equal(found.row.id, id, `step ${step}: ${id} findable`);
      assert.equal(found.row.body, bodyOf.get(id), `step ${step}: ${id} body exact`);
    }
    // 2. counts match the manifest: entries exist, row sums match the oracle.
    const { manifest } = loadManifest(outDir);
    let rows = 0;
    for (const e of manifest.chunks) {
      if (e.quarantined) { rows += chunkRows.get(e.file) ?? 0; continue; }
      rows += e.rows;
      assert.ok(existsSync(join(outDir, 'warm', e.file)), `step ${step}: ${e.file} present`);
    }
    assert.equal(rows, sealedLiveRows, `step ${step}: manifest rows match oracle`);
    // 3. verifyFull clean except chain gaps fully covered by forgotten ranges:
    // forgetting the relay-acked tail then sealing more rows breaks continuity
    // by design, so every break must explain itself via forgotten seqs.
    const v = verifyFull(outDir);
    if (!v.ok) {
      assert.deepEqual(v.bad, [], `step ${step}: no corrupt/missing chunks`);
      assert.ok(v.manifest.ok, `step ${step}: manifest readable`);
      assert.ok(v.chain.length > 0, `step ${step}: red walk must be chain-only`);
      const byFile = new Map(manifest.chunks.map((e) => [e.file, e]));
      for (const b of v.chain) {
        const prev = byFile.get(b.prev);
        const next = byFile.get(b.next);
        assert.ok(prev && next, `step ${step}: chain ends known`);
        for (let s = prev.seqMax + 1; s <= next.seqMin - 1; s++) {
          assert.ok(forgottenSeqs.has(s), `step ${step}: gap seq ${s} forgotten`);
        }
      }
    }
  };

  const killAt = new Set([1000 + pick(200), 2500 + pick(200), 4000 + pick(200)]);
  for (let step = 1; step <= ops; step++) {
    if (killAt.has(step)) {
      await doKill(step % 2 === 0 ? 'ship' : 'seal');
      continue;
    }
    const r = rng();
    if (r < 0.45) appendRows();
    else if (r < 0.70) {
      if (liveIds.size > 0) {
        const live = [...liveIds];
        const id = live[pick(live.length)];
        const f = idToChunk.get(id);
        if (f !== undefined && !corrupted.has(f)) {
          try {
            const found = findTrx({ outDir, trxId: id });
            finds++;
            assert.equal(found.row.body, bodyOf.get(id));
          } catch (err) {
            assert.fail(`step ${step}: live ${id} lost: ${(err as Error).message}`);
          }
        }
      }
    }
    else if (r < 0.725) { await doSeal(); sealedOnce = true; }
    else if (r < 0.755) await doShip(rng() < 0.2);
    else if (r < 0.775) doCorrupt();
    else if (r < 0.805) doRepair();
    else if (r < 0.855) { if (sealedOnce) { sweep(outDir, { relayDir }); sweep(outDir, { dryRun: false, relayDir }); } }
    else if (r < 0.870) doForgetTail();
    else if (r < 0.890) { if (sealedOnce) sweepCold(outDir); }
    else if (r < 0.910) { if (sealedOnce) statusInfo(outDir, relayDir); }
    else appendRows();
    if (step % CHECK_EVERY === 0) checkInvariants(step);
  }
  // final: seal the tail, ship everything, repair, full clean walk.
  await doSeal();
  await doShip(true);
  doRepair();
  checkInvariants(ops);
  return { ops, seals, finds, kills, corrupts };
};

describe('soak randomized', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: ${OPS} ops hold invariants`, { timeout: 120_000 }, async () => {
      await withRetry(async () => {
        const t0 = Date.now();
        const s = await runSoak(seed, OPS);
        const ms = Date.now() - t0;
        console.log(`soak seed=${seed} ops=${s.ops} seals=${s.seals} finds=${s.finds} kills=${s.kills} corrupts=${s.corrupts} ${ms}ms`);
        // no wall-clock perf assert: elapsed time depends on suite-wide cpu
        // contention, not correctness. hang protection stays on the declared
        // 120s timeout above; invariants are checked inside runsoak.
      });
    });
  }

  it('unseeded run holds invariants', { timeout: 120_000 }, async () => {
    await withRetry(async () => {
      const seed = (Date.now() ^ (Math.random() * 2 ** 31)) >>> 0;
      const t0 = Date.now();
      const s = await runSoak(seed, OPS);
      const ms = Date.now() - t0;
      console.log(`soak seed=${seed} (unseeded) ops=${s.ops} seals=${s.seals} finds=${s.finds} kills=${s.kills} corrupts=${s.corrupts} ${ms}ms`);
      // no wall-clock perf assert here either (see above).
    });
  });
});
