// Guardrail regressions: alerts must throw on missing/corrupt archives (never
// ok-with-zero-counts), chunk codec must reject non-finite ts (never persist
// null via JSON), repairAll must bind the manifest sha post-repair (not
// crc-only), and verifyFull must cover photo sidecars.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { checkUnacked } from '../src/alerts.js';
import { decodeChunk, decodeHeader, decodeRows, encodeChunk, encodeRows, DICT_FLAG } from '../src/chunk.js';
import type { HotRow } from '../src/chunk.js';
import { loadDictFor } from '../src/dict.js';
import { findTrx } from '../src/find.js';
import { loadManifest } from '../src/manifest.js';
import { seal, normRow } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { repairAll, verifyFull } from '../src/verify.js';
import { scratch, writeHotLog } from './util.js';

function row(ts: number): HotRow {
  return { device_id: 'dev-01', seq: 1, ts, id: 'trx-00000001', table: 'events', body: 'ok' };
}

function owningChunk(outDir: string, ref: string): string {
  for (const f of readdirSync(join(outDir, 'warm')).filter((f) => f.endsWith('.chk')).sort()) {
    const buf = readFileSync(join(outDir, 'warm', f));
    let dict: Buffer | undefined;
    try {
      const h = decodeHeader(buf);
      dict = (h.flags & DICT_FLAG) !== 0 ? loadDictFor(join(outDir, 'dicts'), h.dictId) ?? undefined : undefined;
    } catch { continue; }
    let rows: HotRow[];
    try { rows = decodeChunk(buf, dict).rows; } catch { continue; }
    if (rows.some((r) => r.body === ref)) return f;
  }
  throw new Error('owning chunk not found');
}

describe('guardrails', () => {
  it('alerts throw on missing or corrupt archive, never ok with zero counts', { timeout: 30_000 }, async () => {
    const dir = scratch('guard-alert');
    assert.throws(
      () => checkUnacked(join(dir, 'no-such-archive'), join(dir, 'relay'), { freeBytes: 10 ** 12 }),
      /no readable manifest/,
    );
    const torn = join(dir, 'torn');
    const warm = join(torn, 'warm');
    const { mkdirSync } = await import('fs');
    mkdirSync(warm, { recursive: true });
    writeFileSync(join(torn, 'manifest.json'), '{torn garbage');
    writeFileSync(join(torn, 'manifest.bak.json'), '[1,2,');
    assert.throws(() => checkUnacked(torn, join(dir, 'relay'), { freeBytes: 10 ** 12 }), /no readable manifest/);

    // Control: a real archive still reports, never throws.
    const { hotDb } = writeHotLog(dir, { rows: 200 });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir });
    const a = checkUnacked(outDir, join(dir, 'relay'), { freeBytes: 10 ** 12 });
    assert.equal(a.unknown.length, 0);
  });

  it('chunk codec rejects non-finite ts instead of persisting null', { timeout: 30_000 }, () => {
    assert.throws(() => encodeRows([row(NaN)]), /non-finite ts/);
    assert.throws(() => encodeRows([row(Infinity)]), /non-finite ts/);
    assert.throws(() => encodeChunk('events', [row(NaN)]), /non-finite ts/);
    // normRow half: NaN ts is malformed (dropped), never a row with null ts.
    assert.equal(normRow({ device_id: 'd', seq: 1, ts: NaN, id: 'x' }, 'log'), null);
    // A frame already carrying null ts (NaN stringified pre-fix, or crafted)
    // must fail loud on decode, never yield silently wrong rows.
    const { raw } = encodeRows([row(1000)]);
    const frame = JSON.parse(raw.toString('utf8')) as { tsB: number };
    frame.tsB = null as unknown as number;
    assert.throws(() => decodeRows(Buffer.from(JSON.stringify(frame), 'utf8')), /non-finite/);
  });

  it('repairAll binds the manifest sha: poisoned relay never writes', { timeout: 60_000 }, async () => {
    const dir = scratch('guard-repair');
    const { hotDb } = writeHotLog(dir, { rows: 4000, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    const sealed = await seal({ hotDb, outDir, targetBytes: 8 * 1024 });
    assert.ok(sealed.chunks.length >= 2, 'need >=2 chunks for a crc-valid poison donor');
    await ship({ outDir, relayDir, baseDelayMs: 1 });
    const files = sealed.chunks.map((c) => c.split(/[\\/]/).pop() as string);
    const victim = files[0];
    const donor = files[1];
    const shaBefore = loadManifest(outDir).manifest.chunks.find((e) => e.file === victim)?.sha256;
    assert.ok(shaBefore);

    // Corrupt the warm copy, then poison the relay with a *different* valid
    // chunk (crc-clean, wrong sha for this entry).
    const warmFull = join(outDir, 'warm', victim);
    const warmBytes = readFileSync(warmFull);
    const poison = readFileSync(join(outDir, 'warm', donor));
    assert.notEqual(poison.toString('hex'), warmBytes.toString('hex'));
    const relayFile = join(relayDir, 'chunks', victim);
    const goodRelay = readFileSync(relayFile);
    const wb = Buffer.from(warmBytes);
    wb[wb.length - 1] ^= 0x01;
    writeFileSync(warmFull, wb);
    writeFileSync(relayFile, poison);

    const r = repairAll(outDir, relayDir);
    assert.equal(r.ok, false);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].file, victim);
    assert.match(r.failed[0].error, /relay copy hash differs from manifest/);
    assert.deepEqual(readFileSync(warmFull), wb, 'poison never written to warm');
    assert.equal(
      loadManifest(outDir).manifest.chunks.find((e) => e.file === victim)?.sha256,
      shaBefore,
      'manifest sha still bound to the original bytes',
    );

    // Happy path still repairs once the relay is honest.
    writeFileSync(relayFile, goodRelay);
    const r2 = repairAll(outDir, relayDir);
    assert.equal(r2.ok, true);
    assert.deepEqual(r2.repaired, [victim]);
    assert.ok(verifyFull(outDir).ok);
  });

  it('verifyFull covers photo blobs: missing or tampered sidecar fails', { timeout: 60_000 }, async () => {
    const dir = scratch('guard-photo');
    const blob = randomBytes(300 * 1024);
    const base = 1_700_000_000_000;
    const lines = [
      JSON.stringify({ device_id: 'dev-01', seq: 1, ts: base + 1000, id: 'trx-00000001', table: 'events', body: 'TRANSACTION OK' }),
      JSON.stringify({ device_id: 'cam-01', seq: 2, ts: base + 2000, id: 'trx-00000002', table: 'photo', body: blob.toString('base64') }),
    ];
    const hotDb = join(dir, 'hot.jsonl');
    writeFileSync(hotDb, `${lines.join('\n')}\n`);
    const outDir = join(dir, 'archive');
    const sealed = await seal({ hotDb, outDir });
    assert.equal(sealed.rowsSealed, 2);
    const ref = findTrx({ outDir, trxId: 'trx-00000002' }).row.body;
    const m = /^photo:sha256:([0-9a-f]{64}):size=(\d+)$/.exec(ref);
    assert.ok(m, `photo body seals as a hash ref, got ${ref.slice(0, 40)}`);
    const owner = owningChunk(outDir, ref);
    assert.ok(verifyFull(outDir).ok, 'intact photo archive verifies clean');

    const sidecar = join(outDir, 'photo', `${m[1]}.bin`);
    const good = readFileSync(sidecar);
    unlinkSync(sidecar);
    const missing = verifyFull(outDir);
    assert.equal(missing.ok, false, 'missing photo sidecar must fail verifyFull');
    assert.ok(missing.bad.includes(owner), 'bad names the owning chunk');
    assert.match(missing.items.find((i) => i.file === owner)?.reason ?? '', /photo sidecar missing/);

    const tampered = Buffer.from(good);
    tampered[0] ^= 0xff;
    writeFileSync(sidecar, tampered);
    const badHash = verifyFull(outDir);
    assert.equal(badHash.ok, false, 'tampered photo sidecar must fail verifyFull');
    assert.match(badHash.items.find((i) => i.file === owner)?.reason ?? '', /photo sidecar hash differs/);

    writeFileSync(sidecar, good);
    assert.ok(verifyFull(outDir).ok, 'restored sidecar verifies clean again');
  });
});
