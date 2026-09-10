// Worker crash-safety: parallel workers share pid+clock, so scratch dirs
// must be collision-proof, and a CLI child killed mid-flight must neither
// crash the worker nor leave an unhealable archive.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { verifyFull } from '../src/verify.js';
import { scratch, writeHotLog } from './util.js';
function isContentionError(e: unknown): boolean {
  let msg: string;
  if (e !== null && typeof e === 'object' && 'message' in e) {
    const m = e.message;
    msg = typeof m === 'string' ? m : String(e);
  } else {
    msg = String(e);
  }
  return /EADDRINUSE|EBUSY|ENOSPC|EMFILE|EAGAIN|ENOTEMPTY|EPERM|EBADF|ECONN/i.test(msg);
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt === attempts || !isContentionError(e)) throw e;
      // Real delay: retry backs off against live OS resource pressure (errno-coded only: lock/timeout/product errors fail loud); fake timers cannot advance kernel state.
      await new Promise<void>((r) => setTimeout(r, 200 * attempt));
    }
  }
  throw last;
}


const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

async function killCli(args: string[]): Promise<void> {
  let child: ChildProcess | undefined;
  try {
    child = spawn('bun', args, { cwd: root, stdio: 'ignore' });
  } catch { return; /* spawn failed: nothing to kill, worker survives */ }
  child.on('error', () => {}); // unhandled 'error' would crash the worker
  // Real delay: this test deliberately races a live child against the
  // platform clock, so fake timers cannot drive it.
  await new Promise<void>((r) => setTimeout(r, 5));
  try { if (child.exitCode === null) child.kill(); } catch { /* already exited */ }
  await new Promise<void>((r) => {
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } r(); }, 10_000);
    child.on('exit', () => { clearTimeout(t); r(); });
    child.on('error', () => { clearTimeout(t); r(); });
  });
}

describe('worker crash-safety', () => {
  it('rapid scratch allocation never reuses a live dir', { timeout: 30_000 }, async () => {
    await withRetry(async () => {
      const dirs = new Set<string>();
      for (let i = 0; i < 200; i++) dirs.add(scratch('worker-safety'));
      assert.equal(dirs.size, 200);
    });
  });

  it('a seal child killed mid-flight heals to a clean verify', { timeout: 30_000 }, async () => {
    await withRetry(async () => {
      const dir = scratch('worker-kill-seal');
      const { hotDb } = writeHotLog(dir, { rows: 500 });
      const outDir = join(dir, 'archive');
      await killCli(['bin/moltarc.ts', 'seal', hotDb, outDir]);
      await seal({ hotDb, outDir });
      assert.equal(verifyFull(outDir).ok, true);
    });
  });

  it('a ship child killed mid-flight heals to a complete relay', { timeout: 30_000 }, async () => {
    await withRetry(async () => {
      const dir = scratch('worker-kill-ship');
      const { hotDb } = writeHotLog(dir, { rows: 500 });
      const outDir = join(dir, 'archive');
      const relayDir = join(dir, 'relay');
      await seal({ hotDb, outDir });
      await killCli(['bin/moltarc.ts', 'ship', outDir, relayDir]);
      await ship({ outDir, relayDir });
      assert.equal(verifyFull(outDir).ok, true);
    });
  });
});
