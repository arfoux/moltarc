// moltarc verify command: full walk over manifest copies, per-chunk crc+sha,
// filename links, and hash-chain continuity. Gaps are warnings (ok stays true);
// only overlap/regression breaks fail. Exit 0 clean, 1 on any finding.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { HEADER_SIZE } from '../src/chunk.js';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { forgetChunks } from '../src/cold.js';
import { loadManifest, saveManifestAtomic } from '../src/manifest.js';
import { printChainGaps, quarantine, repairByHash, verifyFull } from '../src/verify.js';
import { scratch, writeHotLog } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'moltarc.ts');

function run(...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000 });
}

function runFail(...args: string[]): { status: number; stdout: string } {
  try {
    run(...args);
    assert.fail(`expected moltarc ${args[0]} to exit nonzero`);
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { status: err.status ?? 1, stdout: String(err.stdout ?? '') };
  }
}

async function sealedArchive(name: string): Promise<{ dir: string; outDir: string; relayDir: string; files: string[] }> {
  const dir = scratch(name);
  const { hotDb } = writeHotLog(dir, { rows: 4000, uniqueBodies: true });
  const outDir = join(dir, 'archive');
  const relayDir = join(dir, 'relay');
  const sealed = await seal({ hotDb, outDir, targetBytes: 8 * 1024 });
  assert.ok(sealed.chunks.length >= 3, `need >=3 chunks, got ${sealed.chunks.length}`);
  await ship({ outDir, relayDir, baseDelayMs: 1 });
  const files = sealed.chunks.map((c) => c.split(/[\\/]/).pop() as string);
  return { dir, outDir, relayDir, files };
}

describe('moltarc verify', () => {
  it('clean archive walks ok with per-chunk ok lines and exit 0', { timeout: 30_000 }, async () => {
    const { outDir, files } = await sealedArchive('verify-clean');
    const v = verifyFull(outDir);
    assert.ok(v.ok);
    assert.equal(v.manifest.source, 'primary');
    assert.equal(v.items.length, files.length);
    assert.ok(v.items.every((i) => i.status === 'OK'));
    assert.equal(v.chain.length, 0);
    assert.equal(v.chainGaps.length, 0);
    assert.equal(v.bad.length, 0);

    const out = run('verify', outDir);
    for (const f of files) assert.ok(out.includes(`OK ${f}`), `missing OK line for ${f}`);
    assert.match(out, /manifest: OK \(primary/);
    assert.match(out, /chain: OK/);
    assert.match(out, /verify: \d+ ok, 0 corrupt, 0 missing, 0 quarantined, 0 chain break\(s\) — OK/);
  });

  it('1 flipped body bit reports exactly 1 corrupt chunk and exits 1', { timeout: 30_000 }, async () => {
    const { outDir, files } = await sealedArchive('verify-bitflip');
    const victim = files[1];
    const full = join(outDir, 'warm', victim);
    const buf = Buffer.from(readFileSync(full));
    buf[HEADER_SIZE + 7] ^= 0x01;
    writeFileSync(full, buf);

    const v = verifyFull(outDir);
    assert.ok(!v.ok);
    assert.deepEqual(v.bad, [victim]);
    const hit = v.items.find((i) => i.file === victim);
    assert.equal(hit?.status, 'CORRUPT');
    assert.match(hit?.reason ?? '', /crc32c mismatch/);
    assert.ok(v.items.filter((i) => i.file !== victim).every((i) => i.status === 'OK'));

    const r = runFail('verify', outDir);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes(`CORRUPT ${victim}`), 'names the corrupt chunk');
    assert.ok(r.stdout.includes(`OK ${files[0]}`), 'healthy chunks still list ok');
    assert.match(r.stdout, /verify: \d+ ok, 1 corrupt.*— FAIL/);
  });

  it('header-only flip is caught by the manifest sha check, not the crc', { timeout: 30_000 }, async () => {
    const { outDir, files } = await sealedArchive('verify-sha');
    const victim = files[0];
    const full = join(outDir, 'warm', victim);
    const buf = Buffer.from(readFileSync(full));
    buf[60] ^= 0x01; // reserved header byte: body crc stays valid, file sha breaks
    writeFileSync(full, buf);

    const v = verifyFull(outDir);
    assert.ok(!v.ok);
    const hit = v.items.find((i) => i.file === victim);
    assert.equal(hit?.status, 'CORRUPT');
    assert.match(hit?.reason ?? '', /sha256 differs from manifest/);
  });

  // Heavy integration path (4000-row seal + ship + fresh-bun CLI verify):
  // ~0.5s solo but >5s under concurrent-suite CPU contention, past bun's
  // default 5s per-test timeout. Budget declared explicitly; logic untouched.
  it('primary manifest loss falls back to backup and still fails the walk', { timeout: 30_000 }, async () => {
    const { outDir } = await sealedArchive('verify-manifest');
    const primary = readFileSync(join(outDir, 'manifest.json'));
    writeFileSync(join(outDir, 'manifest.json'), primary.subarray(0, Math.floor(primary.length / 2)));

    const v = verifyFull(outDir);
    assert.equal(v.manifest.source, 'backup');
    assert.ok(!v.manifest.ok);
    assert.ok(!v.ok);

    const r = runFail('verify', outDir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /manifest: CORRUPT \(primary corrupt, fell back to backup\)/);
  });

  it('forgotten middle chunk shows as a chain-gap warning, ok stays true', { timeout: 30_000 }, async () => {
    const { outDir, relayDir, files } = await sealedArchive('verify-chain');
    const middle = [...files].sort()[1];
    forgetChunks(outDir, [middle], relayDir);

    const v = verifyFull(outDir);
    assert.equal(v.chain.length, 0, 'forward skip is a gap, not a break');
    assert.equal(v.chainGaps.length, 1);
    assert.ok(v.chainGaps[0].missing >= 1, `missing count, got ${v.chainGaps[0].missing}`);
    assert.match(v.chainGaps[0].prev, /\.chk$/);
    assert.match(v.chainGaps[0].next, /\.chk$/);
    assert.ok(v.ok, 'gaps are warnings only');
    printChainGaps(v);

    const out = run('verify', outDir);
    assert.match(out, /verify: .* — OK/, 'gap does not fail the walk');
  });

  it('bounded multi-seal global-seq corpus verifies ok with chainGaps>=1', { timeout: 60_000 }, async () => {
    const dir = scratch('verify-multiseal');
    const outDir = join(dir, 'archive');
    const writeBatch = (name: string, startSeq: number, rows: number): string => {
      const lines: string[] = [];
      for (let i = 0; i < rows; i++) {
        const seq = startSeq + i;
        lines.push(JSON.stringify({
          device_id: 'pos-01', seq, ts: 1_700_000_000_000 + seq * 1000,
          id: `trx-${String(seq).padStart(8, '0')}`, table: 'events',
          body: `TRANSACTION seq=${seq} ref=${((seq * 2654435761) >>> 0).toString(16)} value=${15000 + (seq % 97)}`,
        }));
      }
      const p = join(dir, name);
      writeFileSync(p, `${lines.join('\n')}\n`);
      return p;
    };
    const hot1 = writeBatch('hot1.jsonl', 1, 1500);
    const s1 = await seal({ hotDb: hot1, outDir, targetBytes: 8 * 1024 });
    assert.ok(s1.chunks.length >= 2, `first seal needs >=2 chunks, got ${s1.chunks.length}`);
    // Bounded second seal skips global seq 1501..2499 (filtered tail): the hole
    // is a legitimate forward skip, not lost history.
    const hot2 = writeBatch('hot2.jsonl', 2500, 1500);
    const s2 = await seal({ hotDb: hot2, outDir, targetBytes: 8 * 1024 });
    assert.ok(s2.chunks.length >= 2, `second seal needs >=2 chunks, got ${s2.chunks.length}`);

    const v = verifyFull(outDir);
    assert.equal(v.chain.length, 0);
    assert.ok(v.chainGaps.length >= 1, `expected >=1 gap, got ${v.chainGaps.length}`);
    assert.ok(v.chainGaps.every((g) => g.missing >= 1));
    assert.ok(v.chainGaps.some((g) => g.missing >= 999), 'hole 1501..2499 surfaces with a bounded missing count');
    assert.ok(v.ok, 'multi-seal gap verifies ok');
    printChainGaps(v);
  });

  it('overlap/regression stays a chain break and fails the walk', { timeout: 30_000 }, async () => {
    const { outDir } = await sealedArchive('verify-overlap');
    const loaded = loadManifest(outDir);
    const sorted = [...loaded.manifest.chunks].sort((a, b) => a.seqMin - b.seqMin);
    assert.ok(sorted.length >= 3, 'need >=3 chunks for an overlap probe');
    // Force the second chunk to start inside the first: seqMin <= prev.seqMax.
    sorted[1].seqMin = sorted[0].seqMax;
    saveManifestAtomic(outDir, loaded.manifest);

    const v = verifyFull(outDir);
    assert.equal(v.chain.length, 1, 'overlap stays a break');
    assert.equal(v.chainGaps.length, 0, 'overlap is not a gap');
    assert.ok(!v.ok);

    const r = runFail('verify', outDir);
    assert.equal(r.status, 1);
  });

  it('quarantine/repairByHash refuse traversal filenames', { timeout: 30_000 }, async () => {
    const { outDir, relayDir, files } = await sealedArchive('verify-traversal');
    assert.throws(() => quarantine(outDir, '../evil.chk'), /bad chunk name/);
    assert.throws(() => quarantine(outDir, 'a/b.chk'), /bad chunk name/);
    assert.throws(() => repairByHash(outDir, relayDir, '..\\evil.chk'), /bad chunk name/);
    assert.throws(() => repairByHash(outDir, relayDir, 'nope-not-a-chunk'), /bad chunk name|unknown chunk/);
    assert.ok(files.length >= 3);
  });

  it('truncated chunk reports corrupt and exits 1', { timeout: 30_000 }, async () => {
    const { outDir, files } = await sealedArchive('verify-truncate');
    const victim = files[1];
    const full = join(outDir, 'warm', victim);
    const buf = readFileSync(full);
    writeFileSync(full, buf.subarray(0, Math.floor(buf.length / 2)));

    const v = verifyFull(outDir);
    assert.ok(!v.ok);
    assert.deepEqual(v.bad, [victim]);
    const hit = v.items.find((i) => i.file === victim);
    assert.equal(hit?.status, 'CORRUPT');
    assert.match(hit?.reason ?? '', /truncated body|bad header/);
    assert.ok(v.items.filter((i) => i.file !== victim).every((i) => i.status === 'OK'));

    const r = runFail('verify', outDir);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes(`CORRUPT ${victim}`), 'names the truncated chunk');
    assert.match(r.stdout, /verify: \d+ ok, 1 corrupt.*— FAIL/);
  });
});
