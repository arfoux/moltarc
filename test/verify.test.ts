// molt verify command: full walk over manifest copies, per-chunk crc+sha,
// filename links, and hash-chain continuity. Exit 0 clean, 1 on any finding.
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
import { verifyFull } from '../src/verify.js';
import { scratch, writeHotLog } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'molt.ts');

function run(...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

function runFail(...args: string[]): { status: number; stdout: string } {
  try {
    run(...args);
    assert.fail(`expected molt ${args[0]} to exit nonzero`);
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

describe('molt verify', () => {
  it('clean archive walks ok with per-chunk ok lines and exit 0', async () => {
    const { outDir, files } = await sealedArchive('verify-clean');
    const v = verifyFull(outDir);
    assert.ok(v.ok);
    assert.equal(v.manifest.source, 'primary');
    assert.equal(v.items.length, files.length);
    assert.ok(v.items.every((i) => i.status === 'OK'));
    assert.equal(v.chain.length, 0);
    assert.equal(v.bad.length, 0);

    const out = run('verify', outDir);
    for (const f of files) assert.ok(out.includes(`OK ${f}`), `missing OK line for ${f}`);
    assert.match(out, /manifest: OK \(primary/);
    assert.match(out, /chain: OK/);
    assert.match(out, /verify: \d+ ok, 0 corrupt, 0 missing, 0 quarantined, 0 chain break\(s\) — OK/);
  });

  it('1 flipped body bit reports exactly 1 corrupt chunk and exits 1', async () => {
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

  it('header-only flip is caught by the manifest sha check, not the crc', async () => {
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

  it('forgotten middle chunk shows as a hash-chain gap', async () => {
    const { outDir, files } = await sealedArchive('verify-chain');
    const middle = [...files].sort()[1];
    forgetChunks(outDir, [middle]);

    const v = verifyFull(outDir);
    assert.equal(v.chain.length, 1);
    assert.ok(!v.ok);
    assert.match(v.chain[0].prev, /\.chk$/);

    const r = runFail('verify', outDir);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('CHAIN'), 'prints the chain break');
  });
});
