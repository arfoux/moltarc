// moltarc repair command: re-fetch corrupt chunks by hash from the relay dir
// (ship target), then re-verify clean. Corrupt-then-repair roundtrip first.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { HEADER_SIZE } from '../src/chunk.js';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { quarantine, repairAll, repairByHash, verifyFull } from '../src/verify.js';
import { scratch, writeHotLog } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'moltarc.ts');

function run(...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

async function shippedArchive(name: string): Promise<{ outDir: string; relayDir: string; files: string[] }> {
  const dir = scratch(name);
  const { hotDb } = writeHotLog(dir, { rows: 4000, uniqueBodies: true });
  const outDir = join(dir, 'archive');
  const relayDir = join(dir, 'relay');
  const sealed = await seal({ hotDb, outDir, targetBytes: 8 * 1024 });
  assert.ok(sealed.chunks.length >= 3, `need >=3 chunks, got ${sealed.chunks.length}`);
  await ship({ outDir, relayDir, baseDelayMs: 1 });
  return { outDir, relayDir, files: sealed.chunks.map((c) => c.split(/[\\/]/).pop() as string) };
}

function flipBit(outDir: string, file: string): void {
  const full = join(outDir, 'warm', file);
  const buf = Buffer.from(readFileSync(full));
  buf[HEADER_SIZE + 11] ^= 0x01;
  writeFileSync(full, buf);
}

describe('moltarc repair', () => {
  it('corrupt-then-repair roundtrip ends verify-clean with relay bytes', async () => {
    const { outDir, relayDir, files } = await shippedArchive('repair-roundtrip');
    const victim = files[2];
    flipBit(outDir, victim);
    assert.deepEqual(verifyFull(outDir).bad, [victim]);

    const out = run('repair', outDir, relayDir);
    assert.ok(out.includes(`REPAIRED ${victim}`), 'names the repaired chunk');
    assert.match(out, /repair: 1 repaired, 0 failed — OK/);
    assert.match(out, /verify: \d+ ok, 0 corrupt.*— OK/);

    const v = verifyFull(outDir);
    assert.ok(v.ok);
    assert.equal(v.bad.length, 0);
    assert.ok(
      readFileSync(join(outDir, 'warm', victim)).equals(readFileSync(join(relayDir, 'chunks', victim))),
      'repaired bytes equal the relay copy',
    );
    // Quarantine path heals the same way through the single-chunk helper.
    flipBit(outDir, victim);
    quarantine(outDir, victim);
    repairByHash(outDir, relayDir, victim);
    assert.ok(verifyFull(outDir).ok);
  });

  it('deleted warm file is re-fetched by hash from the relay index', async () => {
    const { outDir, relayDir, files } = await shippedArchive('repair-missing');
    const victim = files[0];
    unlinkSync(join(outDir, 'warm', victim));
    const before = verifyFull(outDir);
    assert.equal(before.items.find((i) => i.file === victim)?.status, 'MISSING');

    const r = repairAll(outDir, relayDir);
    assert.ok(r.ok);
    assert.deepEqual(r.repaired, [victim]);
    assert.equal(r.failed.length, 0);
    assert.ok(r.verify.ok);
  });

  it('relay without the chunk fails loud and leaves the walk red', async () => {
    const { outDir, relayDir, files } = await shippedArchive('repair-norelay');
    const victim = files[1];
    flipBit(outDir, victim);
    unlinkSync(join(relayDir, 'chunks', victim));

    const r = repairAll(outDir, relayDir);
    assert.ok(!r.ok);
    assert.equal(r.repaired.length, 0);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].file, victim);
    assert.match(r.failed[0].error, /relay has no copy/);
    assert.ok(!r.verify.ok);

    let cliOut = '';
    try {
      run('repair', outDir, relayDir);
    } catch (e) {
      if (e && typeof e === 'object' && 'stdout' in e) cliOut = String(e.stdout);
    }
    assert.ok(cliOut.includes(`FAILED ${victim}`), 'cli names the unrepairable chunk');
  });

  it('tampered relay copy is rejected by hash and never written', async () => {
    const { outDir, relayDir, files } = await shippedArchive('repair-tamper');
    const victim = files[1];
    flipBit(outDir, victim);
    const relayFile = join(relayDir, 'chunks', victim);
    const tampered = Buffer.from(readFileSync(relayFile));
    tampered[HEADER_SIZE + 3] ^= 0xff;
    writeFileSync(relayFile, tampered);

    const r = repairAll(outDir, relayDir);
    assert.ok(!r.ok);
    assert.match(r.failed[0].error, /relay copy hash differs from manifest/);
    assert.deepEqual(verifyFull(outDir).bad, [victim]);
  });
});
