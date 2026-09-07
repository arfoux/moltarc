// Single-corrupt-chunk survival: 1 chunk quarantines, history stays readable, repair-by-hash heals.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { HEADER_SIZE } from '../src/chunk.js';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { findTrx } from '../src/find.js';
import { loadManifest } from '../src/manifest.js';
import { verifyAll, verifyFull, quarantine, repairByHash } from '../src/verify.js';
import { scratch, writeHotLog } from './util.js';

describe('corrupt chunk survival', () => {
  it('quarantines exactly 1 chunk and repairs it from the relay', { timeout: 30_000 }, async () => {
    const dir = scratch('corrupt');
    const { hotDb, ids } = writeHotLog(dir, { rows: 4000, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    const sealed = await seal({ hotDb, outDir, targetBytes: 8 * 1024 });
    assert.ok(sealed.chunks.length >= 3, `need >=3 chunks, got ${sealed.chunks.length}`);
    await ship({ outDir, relayDir, baseDelayMs: 1 });

    // Corrupt one byte in a middle chunk body (past the 64B header).
    const victim = sealed.chunks[1];
    const buf = Buffer.from(readFileSync(victim));
    buf[HEADER_SIZE + 7] ^= 0xff;
    writeFileSync(victim, buf);

    const v = verifyAll(outDir);
    assert.equal(v.bad.length, 1);
    assert.equal(v.bad[0], victim.split(/[\\/]/).pop());

    quarantine(outDir, v.bad[0]);
    const q = loadManifest(outDir).manifest.chunks.find((e) => e.file === v.bad[0]);
    assert.equal(q?.quarantined, true);
    assert.ok(existsSync(join(outDir, 'quarantine', v.bad[0])));

    // History outside the bad chunk stays readable (probe the last chunk's max key).
    const lastEntry = loadManifest(outDir).manifest.chunks
      .filter((e) => !e.quarantined)
      .sort((a, b) => a.seqMax - b.seqMax)
      .pop();
    const probeId = lastEntry?.maxKey ?? ids[ids.length - 1];
    const found = findTrx({ outDir, trxId: probeId });
    assert.equal(found.row.id, probeId);

    repairByHash(outDir, relayDir, v.bad[0]);
    const after = verifyAll(outDir);
    assert.equal(after.bad.length, 0);
    assert.ok(after.ok);
  });

  it('header-only flip quarantines exactly 1 chunk and repairs it from the relay', { timeout: 30_000 }, async () => {
    const dir = scratch('corrupt-header');
    const { hotDb, ids } = writeHotLog(dir, { rows: 4000, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    const sealed = await seal({ hotDb, outDir, targetBytes: 8 * 1024 });
    assert.ok(sealed.chunks.length >= 3, `need >=3 chunks, got ${sealed.chunks.length}`);
    await ship({ outDir, relayDir, baseDelayMs: 1 });

    // Flip a reserved header byte: the body crc stays valid, so only the
    // manifest sha walk flags it — the crc-only walk stays green here.
    const victim = sealed.chunks[1];
    const victimName = victim.split(/[\\/]/).pop() as string;
    const buf = Buffer.from(readFileSync(victim));
    buf[60] ^= 0x01;
    writeFileSync(victim, buf);

    const v = verifyFull(outDir);
    assert.deepEqual(v.bad, [victimName]);
    assert.match(v.items.find((i) => i.file === victimName)?.reason ?? '', /sha256 differs from manifest/);

    quarantine(outDir, victimName);
    const q = loadManifest(outDir).manifest.chunks.find((e) => e.file === victimName);
    assert.equal(q?.quarantined, true);
    assert.ok(existsSync(join(outDir, 'quarantine', victimName)));

    // History outside the bad chunk stays readable (probe the last healthy chunk's max key).
    const lastEntry = loadManifest(outDir).manifest.chunks
      .filter((e) => !e.quarantined)
      .sort((a, b) => a.seqMax - b.seqMax)
      .pop();
    const probeId = lastEntry?.maxKey ?? ids[ids.length - 1];
    const found = findTrx({ outDir, trxId: probeId });
    assert.equal(found.row.id, probeId);

    repairByHash(outDir, relayDir, victimName);
    const after = verifyFull(outDir);
    assert.equal(after.bad.length, 0);
    assert.ok(after.ok);
  });
});
