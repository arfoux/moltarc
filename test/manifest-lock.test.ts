// Manifest-writer lock regression: every manifest writer (seal, mergeCold,
// sweepCold --apply, forget, p2p-sync apply, migrate, quarantine/repair, and
// the saveManifestAtomic/appendEntries primitives) holds the same seal.lock.
// A second writer while held must fail loud (/manifest locked/), never
// interleave or corrupt. Each test FAILS pre-fix (no shared lock: the second
// write lands silently) and PASSES post-fix.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'fs';
import { spawn } from 'node:child_process';
import { join } from 'path';
import {
  acquireManifestLock,
  appendEntries,
  buildBloom,
  loadManifest,
  readManifestLockPid,
  saveManifestAtomic,
  withManifestLock,
} from '../src/manifest.js';
import type { ChunkEntry, Manifest } from '../src/manifest.js';
import { scratch } from './util.js';

function seedManifest(outDir: string): Manifest {
  mkdirSync(join(outDir, 'warm'), { recursive: true });
  const m: Manifest = { version: 1, createdAt: new Date(0).toISOString(), chunks: [], cold: [] };
  saveManifestAtomic(outDir, m);
  return loadManifest(outDir).manifest;
}

function fakeEntry(file: string): ChunkEntry {
  return {
    file,
    table: 't',
    seqMin: 1,
    seqMax: 1,
    tsMin: 1,
    tsMax: 1,
    rows: 1,
    bytes: 8,
    sha256: '0'.repeat(64),
    crc32c: 0,
    dictId: 0,
    codec: 0,
    minKey: '',
    maxKey: '',
    bloom: buildBloom([file]),
  };
}

// A sibling OS process holds the lock while the test attempts a write: the
// attempt must fail loud (/manifest locked/), never interleave. Same-process
// holds are re-entrant by design (outer holders call the primitives), so the
// holder must be a different pid. Pre-fix the primitives take no lock and
// both writes land silently, so the throws assertions FAIL without the fix.
async function withForeignHolder(outDir: string, fn: () => void): Promise<void> {
  const root = join(import.meta.dirname, '..');
  const manifestPath = join(root, 'src', 'manifest.ts');
  const holder = spawn('bun', ['-e', `import { acquireManifestLock } from ${JSON.stringify(manifestPath)}; acquireManifestLock(process.env.OUT!); await Bun.sleep(30000);`], { cwd: root, env: { ...process.env, OUT: outDir }, stdio: 'ignore' });
  holder.on('error', () => {});
  try {
    const t0 = Date.now();
    while (readManifestLockPid(outDir) !== holder.pid) {
      if (holder.exitCode !== null) throw new Error('holder exited before taking the lock');
      if (Date.now() - t0 > 30000) throw new Error('holder never took the lock');
      await Bun.sleep(5);
    }
    fn();
  } finally {
    try { holder.kill(); } catch { /* already exited */ }
    await new Promise<void>((r) => {
      if (holder.exitCode !== null) return r();
      const t = setTimeout(() => r(), 10_000);
      holder.on('exit', () => { clearTimeout(t); r(); });
      holder.on('error', () => { clearTimeout(t); r(); });
    });
  }
}

describe('manifest writer lock', () => {
  it('save while locked throws /manifest locked/ and writes nothing new', { timeout: 60_000 }, async () => {
    const outDir = join(scratch('manifest-lock-held'), 'arch');
    seedManifest(outDir);
    await withForeignHolder(outDir, () => {
      const m = loadManifest(outDir).manifest;
      m.chunks.push(fakeEntry('c-loser.chk'));
      assert.throws(() => saveManifestAtomic(outDir, m), /manifest locked.*held by pid/);
    });
    // The loser never reached the write path: its entry is absent.
    const after = loadManifest(outDir).manifest;
    assert.equal(after.chunks.some((e) => e.file === 'c-loser.chk'), false);
  });

  it('appendEntries while locked throws /manifest locked/', { timeout: 60_000 }, async () => {
    const outDir = join(scratch('manifest-lock-append'), 'arch');
    seedManifest(outDir);
    await withForeignHolder(outDir, () => {
      assert.throws(() => appendEntries(outDir, [fakeEntry('c-a.chk')]), /manifest locked/);
    });
    assert.equal(loadManifest(outDir).manifest.chunks.length, 0);
  });
  it('same-process re-entry proceeds (outer holders call the primitives)', { timeout: 30_000 }, () => {
    const outDir = join(scratch('manifest-lock-reentrant'), 'arch');
    seedManifest(outDir);
    // seal/migrate/cold hold the lock, then call save/append inside it: the
    // inner acquire must be a no-op, and the outer release must free the lock.
    withManifestLock(outDir, () => {
      appendEntries(outDir, [fakeEntry('c-inner.chk')]);
    });
    assert.equal(loadManifest(outDir).manifest.chunks.length, 1);
    assert.equal(existsSync(join(outDir, 'seal.lock')), false, 'outer release must free the lock');
  });
});

// Two-OS-process contention between manifest writers: two `bun -e` processes
// append different entries behind a ready-file barrier (same Bun.spawn pattern
// as test/seallock.test.ts). Post-fix exactly one wins while holding the lock
// and the loser fails loud matching /locked/, then the manifest still loads
// with a valid crc. Pre-fix (no lock) both appends interleave on the same
// base copy and the loser's entry is silently lost, so the exactly-one-wins
// assertion fails.
describe('manifest writer lock two-process contention', () => {
  it('two OS processes appending at once: exactly one wins, loser errors /locked/, manifest stays valid', { timeout: 180_000 }, async () => {
    const worker = (manifestPath: string): string => `
import { existsSync, writeFileSync } from 'fs';
import { acquireManifestLock, buildBloom, loadManifest, saveManifestAtomic } from ${JSON.stringify(manifestPath)};
const outDir = process.env.OUT!;
const tag = process.env.TAG!;
const ready = process.env.READY!;
const peerReady = process.env.PEER_READY!;
writeFileSync(ready, String(process.pid));
const t0 = Date.now();
while (!existsSync(peerReady)) {
  if (Date.now() - t0 > 30000) throw new Error('peer ready timeout: contention barrier never met');
  await Bun.sleep(5);
}
const release = acquireManifestLock(outDir);
try {
// Real delay: the hold window must span OS scheduling skew between two
// separate processes; fake timers cannot advance another process's clock.
await Bun.sleep(400);
const m = loadManifest(outDir).manifest;
m.chunks.push({ file: tag, table: 't', seqMin: 1, seqMax: 1, tsMin: 1, tsMax: 1, rows: 1, bytes: 8, sha256: '0'.repeat(64), crc32c: 0, dictId: 0, codec: 0, minKey: '', maxKey: '', bloom: buildBloom([tag]) });
m.chunks.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
saveManifestAtomic(outDir, m);
console.log('wrote ' + tag);
} finally {
  release();
}
`;
    const dir = scratch('manifest-lock-race');
    const outDir = join(dir, 'arch');
    seedManifest(outDir);
    const root = join(import.meta.dirname, '..');
    const manifestPath = join(root, 'src', 'manifest.ts');
    const readyA = join(dir, 'ready-a');
    const readyB = join(dir, 'ready-b');
    const spawnOne = (tag: string, ready: string, peerReady: string) =>
      Bun.spawn(['bun', '-e', worker(manifestPath)], {
        cwd: root,
        env: { ...process.env, OUT: outDir, TAG: tag, READY: ready, PEER_READY: peerReady },
        stdout: 'pipe',
        stderr: 'pipe',
      });
    const procs = [
      spawnOne('c-a.chk', readyA, readyB),
      spawnOne('c-b.chk', readyB, readyA),
    ];
    const codes = await Promise.all(procs.map((p) => p.exited));
    const errs = await Promise.all(procs.map(async (p) => (await new Response(p.stderr).text()).trim()));
    const outs = await Promise.all(procs.map(async (p) => (await new Response(p.stdout).text()).trim()));
    const wins = codes.filter((c) => c === 0).length;
    if (wins === 2) {
      const { manifest } = loadManifest(outDir);
      const files = new Set(manifest.chunks.map((e) => e.file));
      if (files.has('c-a.chk') && files.has('c-b.chk')) {
        throw new Error('manifest contention window missed (sequential schedule): retrying for real overlap');
      }
      assert.fail(
        `manifest lock missing: both writers exited 0 but an entry was lost (chunks=${JSON.stringify([...files])})`,
      );
    }
    assert.equal(wins, 1, `exactly one writer must win: codes=${JSON.stringify(codes)} errs=${JSON.stringify(errs)}`);
    const loserErr = codes[0] === 0 ? errs[1] : errs[0];
    assert.match(loserErr, /locked/, 'loser must fail loud with the lock error, got: ' + loserErr.slice(-500));
    // Winner's manifest still loads with a valid envelope (no torn copy).
    const { manifest } = loadManifest(outDir);
    assert.equal(manifest.chunks.length, 1, 'exactly the winner entry survives');
    assert.equal(existsSync(join(outDir, 'seal.lock')), false, 'lock must be released after the race');
    void outs;
  });
});
