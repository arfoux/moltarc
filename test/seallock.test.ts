// seal lockfile regression: a second seal while locked must error clearly,
// never watermark-race. Each test FAILS pre-fix (no lockfile) and PASSES post-fix.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { scratch, writeHotLog } from './util.js';
import { verifyFull } from '../src/verify.js';

function lockErrorCode(e: unknown): string | undefined {
  if (e !== null && typeof e === 'object' && 'code' in e) {
    const code = e.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

describe('seal lockfile', () => {
  it('second seal while locked errors clearly and writes nothing', { timeout: 60_000 }, async () => {
    const dir = scratch('seallock-held');
    const { hotDb } = writeHotLog(dir, { rows: 10 });
    const outDir = join(dir, 'arch');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'seal.lock'), `${process.pid}\n`);
    // Pre-fix there is no lock: this seal succeeds instead of rejecting.
    await assert.rejects(seal({ hotDb, outDir }), /seal locked.*held by pid/);
    // The loser never reached the write path: no watermark, no chunks.
    assert.equal(existsSync(join(outDir, 'sealed_upto_seq')), false, 'locked seal must not advance the watermark');
    assert.equal(existsSync(join(outDir, 'warm')), false, 'locked seal must not create chunks');
    assert.equal(existsSync(join(outDir, 'manifest.json')), false, 'locked seal must not write a manifest');
  });

  it('stale lock from a dead pid is removed and the seal proceeds', { timeout: 60_000 }, async () => {
    const dir = scratch('seallock-stale');
    const { hotDb } = writeHotLog(dir, { rows: 10 });
    const outDir = join(dir, 'arch');
    mkdirSync(outDir, { recursive: true });
    const deadPid = 2147483647;
    try {
      process.kill(deadPid, 0);
      assert.fail('test setup: probe pid is alive, pick another dead pid');
    } catch (e) {
      assert.equal(lockErrorCode(e), 'ESRCH', 'probe pid must be dead for a stale-lock test');
    }
    const lockPath = join(outDir, 'seal.lock');
    writeFileSync(lockPath, `${deadPid}\n`);
    const r = await seal({ hotDb, outDir });
    assert.equal(r.rowsSealed, 10);
    // Pre-fix the stale file is ignored and left behind; post-fix it is gone.
    assert.equal(existsSync(lockPath), false, 'stale lock must be removed, never left behind');
  });

  it('unparsable lock content stays locked and loud', { timeout: 60_000 }, async () => {
    const dir = scratch('seallock-garbage');
    const { hotDb } = writeHotLog(dir, { rows: 10 });
    const outDir = join(dir, 'arch');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'seal.lock'), 'not-a-pid\n');
    // Pre-fix there is no lock: this seal succeeds instead of rejecting.
    await assert.rejects(seal({ hotDb, outDir }), /seal locked/);
    assert.equal(existsSync(join(outDir, 'sealed_upto_seq')), false, 'locked seal must not advance the watermark');
  });

  it('a normal seal leaves no lock behind', { timeout: 60_000 }, async () => {
    const dir = scratch('seallock-clean');
    const { hotDb } = writeHotLog(dir, { rows: 10 });
    const outDir = join(dir, 'arch');
    const r = await seal({ hotDb, outDir });
    assert.equal(r.rowsSealed, 10);
    assert.equal(existsSync(join(outDir, 'seal.lock')), false, 'released lock must not litter the archive');
  });
});

// Two-OS-process contention: two `bun -e` processes seal the same outDir at
// once behind a ready-file barrier (same Bun.spawn pattern as
// test/concurrent.test.ts). Post-fix exactly one wins and the loser fails
// loud matching /locked/, then the archive passes verifyFull. Pre-fix (no
// lock) both seals write cleanly, so the exactly-one-wins assertion fails.
describe('seal lockfile two-process contention', () => {
  it('two OS processes sealing at once: exactly one wins, loser errors /locked/, archive verifies', { timeout: 180_000 }, async () => {
    const isRaceFlake = (e: unknown): boolean => {
      const msg = e !== null && typeof e === 'object' && 'message' in e && typeof e.message === 'string' ? e.message : String(e);
      return /contention|busy|locked|timeout/i.test(msg);
    };
    // Real delay: retries wait out OS scheduling skew between the two child
    // processes; fake timers cannot advance separate OS processes.
    const withRaceRetry = async <T>(fn: () => Promise<T>, attempts = 6): Promise<T> => {
      let last: unknown;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          return await fn();
        } catch (e) {
          last = e;
          if (attempt === attempts || !isRaceFlake(e)) throw e;
          await new Promise<void>((r) => setTimeout(r, 300 * attempt));
        }
      }
      throw last;
    };
    // Worker body runs in a fresh `bun -e` OS process: signal readiness, wait
    // for the peer behind the barrier so both seals overlap, then seal once.
    // The loser prints the lock error and exits nonzero; the winner exits 0.
    const contentionWorker = (sealPath: string): string => `
import { existsSync, writeFileSync } from 'fs';
import { seal } from ${JSON.stringify(sealPath)};
const hot = process.env.HOT!;
const outDir = process.env.OUT!;
const ready = process.env.READY!;
const peerReady = process.env.PEER_READY!;
writeFileSync(ready, String(process.pid));
const t0 = Date.now();
while (!existsSync(peerReady)) {
  if (Date.now() - t0 > 30000) throw new Error('peer ready timeout: contention barrier never met');
  await Bun.sleep(5);
}
try {
  const r = await seal({ hotDb: hot, outDir });
  console.log('sealed ' + r.rowsSealed);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
`;
    await withRaceRetry(async () => {
      const dir = scratch('seallock-race');
      // Wide seal (2000 rows) holds the lock long enough that both processes,
      // released from the barrier together, genuinely overlap inside seal().
      const { hotDb } = writeHotLog(dir, { rows: 2000 });
      const outDir = join(dir, 'arch');
      const root = join(import.meta.dirname, '..');
      const sealPath = join(root, 'src', 'seal.ts');
      const readyA = join(dir, 'ready-a');
      const readyB = join(dir, 'ready-b');
      const procs = [
        Bun.spawn(['bun', '-e', contentionWorker(sealPath)], {
          cwd: root,
          env: { ...process.env, HOT: hotDb, OUT: outDir, READY: readyA, PEER_READY: readyB },
          stdout: 'pipe',
          stderr: 'pipe',
        }),
        Bun.spawn(['bun', '-e', contentionWorker(sealPath)], {
          cwd: root,
          env: { ...process.env, HOT: hotDb, OUT: outDir, READY: readyB, PEER_READY: readyA },
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      ];
      const codes = await Promise.all(procs.map((p) => p.exited));
      const errs = await Promise.all(procs.map(async (p) => (await new Response(p.stderr).text()).trim()));
      const wins = codes.filter((c) => c === 0).length;
      // Sequential scheduling (second seal starts after the first releases and
      // seals zero rows cleanly) proves nothing: retry for a real overlap.
      // Pre-fix this is the steady state (no lock, both write), so the retry
      // budget exhausts and the test FAILS without the lockfile.
      if (wins === 2) throw new Error('seal contention window missed (both seals won cleanly): retrying for real overlap (contention)');
      assert.equal(wins, 1, 'exactly one seal wins: codes=' + JSON.stringify(codes) + ' errs=' + JSON.stringify(errs.map((e) => e.slice(-300))));
      const loserErr = codes[0] === 0 ? errs[1] : errs[0];
      assert.match(loserErr, /locked/, 'loser must fail loud with the lock error, got: ' + loserErr.slice(-500));
      const full = verifyFull(outDir);
      assert.equal(full.ok, true, 'archive verifies after the race: ' + JSON.stringify(full.bad) + ' chain=' + JSON.stringify(full.chain));
    });
  });
});
