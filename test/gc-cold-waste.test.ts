// gc+cold waste-fix regressions: unacked-safe sweep default, orphan dict
// collection, dict-carrying cold segments, reserve fail-closed writes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { dictHex } from '../src/dict.js';
import { sweep } from '../src/gc.js';
import { loadManifest, saveManifestAtomic } from '../src/manifest.js';
import { atomicWrite } from '../src/guard.js';
import { quarantine } from '../src/verify.js';
import { forgetChunks, mergeCold, readTar, sweepCold } from '../src/cold.js';
import { scratch, writeHotLog } from './util.js';

function plantOrphan(outDir: string): string {
  const name = 'sales-000999-000999-deadbeef.chk';
  writeFileSync(join(outDir, 'warm', name), Buffer.from('orphan-bytes'));
  return name;
}

describe('gc+cold waste fixes', () => {
  it('sweep apply without relayDir throws (ack unknowable, never deletes blind)', { timeout: 30_000 }, async () => {
    const dir = scratch('gcw-unacked');
    const { hotDb } = writeHotLog(dir, { rows: 200 });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir });
    const orphan = plantOrphan(outDir);
    assert.throws(() => sweep(outDir, { dryRun: false }), /gc --apply requires relayDir/);
    assert.ok(existsSync(join(outDir, 'warm', orphan)), 'orphan bytes stay on disk');
  });

  it('sweep collects orphan dicts and keeps live ones', { timeout: 30_000 }, async () => {
    const dir = scratch('gcw-dict');
    const { hotDb } = writeHotLog(dir, { rows: 1500 });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    await seal({ hotDb, outDir });
    const { manifest } = loadManifest(outDir);
    assert.ok(manifest.chunks.some((e) => e.dictId !== 0), 'repetitive seal trains a dict');
    const live = readdirSync(join(outDir, 'dicts')).filter((f: string) => f.endsWith('.dict'));
    assert.ok(live.length >= 1, 'live dict file on disk');
    const dead = 'dict-deadbeef.dict';
    writeFileSync(join(outDir, 'dicts', dead), Buffer.from('dead-dict-bytes'));

    const dry = sweep(outDir, { dryRun: true, relayDir });
    assert.ok(dry.dictOrphans.includes(dead), 'dry-run reports the dead dict');
    assert.ok(!dry.dictOrphans.some((f) => live.includes(f)), 'live dicts never listed');
    assert.ok(existsSync(join(outDir, 'dicts', dead)), 'dry-run deletes nothing');

    const applied = sweep(outDir, { dryRun: false, relayDir });
    assert.deepEqual(applied.dictsRemoved, [dead], 'apply deletes only the dead dict');
    assert.ok(!existsSync(join(outDir, 'dicts', dead)), 'dead dict gone');
    assert.ok(applied.dictBytesReclaimed > 0, 'dict bytes accounted');
    for (const f of live) assert.ok(existsSync(join(outDir, 'dicts', f)), `live dict kept: ${f}`);
  });

  it('merge packs referenced dicts and refuses when the dict is missing', { timeout: 30_000 }, async () => {
    const dir = scratch('gcw-colddict');
    const { hotDb } = writeHotLog(dir, { rows: 1500 });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir });
    const m = mergeCold(outDir);
    assert.ok(m.dicts.length >= 1, 'segment carries dict members');
    const names = readTar(readFileSync(join(outDir, 'cold', m.segment))).map((x) => x.name);
    for (const d of m.dicts) assert.ok(names.includes(d), `tar carries ${d}`);
    assert.ok(names.some((n) => n.startsWith('dicts/dict-') && n.endsWith('.dict')), 'dict member naming');

    // Forbid colding flagged chunks without their dict: drop the dict file,
    // seal fresh rows so a new chunk needs it, merge must refuse.
    const dir2 = scratch('gcw-coldnodict');
    const w2 = writeHotLog(dir2, { rows: 1500 });
    const out2 = join(dir2, 'archive');
    await seal({ hotDb: w2.hotDb, outDir: out2 });
    const dictFile = readdirSync(join(out2, 'dicts')).find((f: string) => f.endsWith('.dict'));
    assert.ok(dictFile, 'second archive trains a dict too');
    unlinkSync(join(out2, 'dicts', dictFile as string));
    assert.throws(() => mergeCold(out2), /need dict-.*\.dict/, 'merge refuses without the dict');
    assert.ok(!existsSync(join(out2, 'cold', 'seg-000001.tar')), 'refused merge writes no tar');
  });

  it('sweep keeps the dict of a chunk left on disk ahead of the manifest', { timeout: 30_000 }, async () => {
    const dir = scratch('gcw-torn');
    const { hotDb } = writeHotLog(dir, { rows: 1500 });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    await seal({ hotDb, outDir });
    const { manifest } = loadManifest(outDir);
    const victim = manifest.chunks[0];
    assert.ok(victim.dictId !== 0, 'victim chunk needs its dict');
    // Simulate a kill mid-seal: chunk bytes on disk, manifest stale without it.
    const stale = { ...manifest, chunks: manifest.chunks.filter((e) => e.file !== victim.file) };
    saveManifestAtomic(outDir, stale);
    const r = sweep(outDir, { dryRun: false, relayDir });
    assert.ok(r.orphans.includes(victim.file), 'stale-manifest chunk surfaces as orphan');
    assert.ok(r.skippedUnacked.includes(victim.file), 'never-shipped bytes retained');
    assert.deepEqual(r.dictsRemoved, [], 'its dict is not collected while the bytes remain');
    const liveDict = `dict-${dictHex(victim.dictId)}.dict`;
    assert.ok(existsSync(join(outDir, 'dicts', liveDict)), `dict kept: ${liveDict}`);
  });

  it('sweep keeps the dict of a chunk parked in quarantine ahead of repair', { timeout: 30_000 }, async () => {
    const dir = scratch('gcw-quar');
    const { hotDb } = writeHotLog(dir, { rows: 1500 });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    await seal({ hotDb, outDir });
    const { manifest } = loadManifest(outDir);
    const victim = manifest.chunks[0];
    assert.ok(victim.dictId !== 0, 'victim chunk needs its dict');
    // Park the chunk (corrupt path), then let a rescan drop it from the
    // manifest while its bytes still await relay repair.
    quarantine(outDir, victim.file);
    const { manifest: parked } = loadManifest(outDir);
    const stale = { ...parked, chunks: parked.chunks.filter((e) => e.file !== victim.file) };
    saveManifestAtomic(outDir, stale);
    const r = sweep(outDir, { dryRun: false, relayDir });
    assert.deepEqual(r.dictsRemoved, [], 'parked bytes keep their dict');
    const liveDict = `dict-${dictHex(victim.dictId)}.dict`;
    assert.ok(existsSync(join(outDir, 'dicts', liveDict)), `dict kept: ${liveDict}`);
  });

  it('merge and cold sweep fail closed below the 50MB reserve', { timeout: 30_000 }, async () => {
    const dir = scratch('gcw-reserve');
    const { hotDb } = writeHotLog(dir, { rows: 1500 });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir });

    assert.throws(() => mergeCold(outDir, { freeSpaceBytes: 1024 }), /50MB reserve/, 'merge refuses');
    let segs: string[] = [];
    try { segs = readdirSync(join(outDir, 'cold')); } catch { /* no cold dir: nothing written */ }
    assert.equal(segs.length, 0, 'refused merge writes no segment');

    const m = mergeCold(outDir);
    assert.ok(m.segment, 'merge succeeds with space');
    const before = readFileSync(join(outDir, 'cold', m.segment));
    assert.throws(
      () => sweepCold(outDir, { dryRun: false, freeSpaceBytes: 1024 }),
      /50MB reserve/,
      'cold sweep refuses',
    );
    assert.deepEqual(readFileSync(join(outDir, 'cold', m.segment)), before, 'refused sweep rewrites no tar');
  });
});

function shaOf(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

function writeRelayIndex(relayDir: string, index: unknown): void {
  mkdirSync(relayDir, { recursive: true });
  writeFileSync(join(relayDir, 'index.json'), JSON.stringify(index));
}

// Seal a small archive whose warm chunks reference refSha via an inline foto
// hash-ref body, with an unreferenced sidecar (+thumb companions) for deadSha
// parked beside it. The ref body is short non-base64 text, so seal keeps it
// inline and the deep-foto scan decodes it back out of the chunk.
async function sealWithFoto(dir: string): Promise<{ outDir: string; refSha: string; deadSha: string }> {
  const refBytes = randomBytes(64);
  const refSha = shaOf(refBytes);
  const deadBytes = randomBytes(96);
  const deadSha = shaOf(deadBytes);
  const { hotDb } = writeHotLog(dir, { rows: 50 });
  appendFileSync(hotDb, `${JSON.stringify({
    device_id: 'cam-01', seq: 51, ts: 1_700_000_000_000 + 51 * 1000,
    id: 'trx-foto-000001', table: 'foto', body: `foto:sha256:${refSha}:size=${refBytes.length}`,
  })}\n`);
  const outDir = join(dir, 'archive');
  await seal({ hotDb, outDir });
  mkdirSync(join(outDir, 'foto'), { recursive: true });
  writeFileSync(join(outDir, 'foto', `${refSha}.bin`), refBytes);
  writeFileSync(join(outDir, 'foto', `${deadSha}.bin`), deadBytes);
  writeFileSync(join(outDir, 'foto', `thumb-${deadSha}.jpg`), Buffer.from('fake-jpg-bytes'));
  writeFileSync(join(outDir, 'foto', `thumb-${deadSha}.json`), JSON.stringify({ fullSha: deadSha }));
  return { outDir, refSha, deadSha };
}

describe('gc deep foto', () => {
  it('keeps referenced sidecars, collects relay-acked orphans with thumbs', { timeout: 30_000 }, async () => {
    const dir = scratch('gcw-foto-acked');
    const { outDir, refSha, deadSha } = await sealWithFoto(dir);
    const relayDir = join(dir, 'relay');
    writeRelayIndex(relayDir, { chunks: {}, foto: { [refSha]: `${refSha}.bin`, [deadSha]: `${deadSha}.bin` } });
    const dead = [`foto/${deadSha}.bin`, `foto/thumb-${deadSha}.jpg`, `foto/thumb-${deadSha}.json`];

    const dry = sweep(outDir, { dryRun: true, relayDir, deepFoto: true });
    assert.deepEqual(dry.fotoOrphans, dead, 'dry-run lists the dead sidecar plus thumbs');
    assert.deepEqual(dry.fotoRemoved, [], 'dry-run deletes nothing');
    assert.ok(existsSync(join(outDir, 'foto', `${deadSha}.bin`)), 'dry-run keeps bytes');

    const applied = sweep(outDir, { dryRun: false, relayDir, deepFoto: true });
    assert.deepEqual(applied.fotoRemoved, dead, 'apply deletes exactly the acked orphans');
    for (const f of dead) assert.ok(!existsSync(join(outDir, f)), `acked orphan gone: ${f}`);
    assert.ok(existsSync(join(outDir, 'foto', `${refSha}.bin`)), 'referenced sidecar retained');
    assert.ok(applied.bytesReclaimed > 0, 'foto bytes accounted');
  });

  it('retains unreferenced foto the relay has not acked', { timeout: 30_000 }, async () => {
    const dir = scratch('gcw-foto-unacked');
    const { outDir, refSha, deadSha } = await sealWithFoto(dir);
    const relayDir = join(dir, 'relay');
    writeRelayIndex(relayDir, { chunks: {}, foto: { [refSha]: `${refSha}.bin` } });
    const r = sweep(outDir, { dryRun: false, relayDir, deepFoto: true });
    assert.ok(r.fotoOrphans.includes(`foto/${deadSha}.bin`), 'unacked sidecar still listed');
    assert.deepEqual(r.fotoRemoved, [], 'nothing deleted without ack');
    assert.ok(existsSync(join(outDir, 'foto', `${deadSha}.bin`)), 'unacked bytes stay on disk');
    assert.ok(existsSync(join(outDir, 'foto', `thumb-${deadSha}.jpg`)), 'unacked thumb stays');
  });

  it('absent relay foto map retains all (Wave2-tolerant)', { timeout: 30_000 }, async () => {
    const dir = scratch('gcw-foto-nomap');
    const { outDir, deadSha } = await sealWithFoto(dir);
    const relayDir = join(dir, 'relay');
    writeRelayIndex(relayDir, { chunks: {} }); // pre-Wave2 index: no `foto` key
    const r = sweep(outDir, { dryRun: false, relayDir, deepFoto: true });
    assert.ok(r.fotoOrphans.includes(`foto/${deadSha}.bin`), 'orphan still listed');
    assert.deepEqual(r.fotoRemoved, [], 'absent map deletes nothing');
    assert.ok(existsSync(join(outDir, 'foto', `${deadSha}.bin`)), 'bytes stay on disk');
    // Relay dir without any index at all: same fail-closed outcome, no throw.
    const bare = join(dir, 'relay-bare');
    mkdirSync(bare, { recursive: true });
    const r2 = sweep(outDir, { dryRun: false, relayDir: bare, deepFoto: true });
    assert.deepEqual(r2.fotoRemoved, [], 'missing index deletes nothing');
  });

  it('foto sweep is opt-in; torn chunks never fail it; apply without relay throws', { timeout: 30_000 }, async () => {
    const dir = scratch('gcw-foto-optin');
    const { outDir, refSha, deadSha } = await sealWithFoto(dir);
    const relayDir = join(dir, 'relay');
    const off = sweep(outDir, { dryRun: false, relayDir });
    assert.deepEqual(off.fotoOrphans, [], 'deepFoto defaults off: no foto scan');
    assert.deepEqual(off.fotoRemoved, [], 'deepFoto defaults off: no foto delete');
    assert.ok(existsSync(join(outDir, 'foto', `${deadSha}.bin`)), 'sidecar untouched');
    // Torn .chk garbage decodes to nothing: the foto scan skips it, never throws.
    writeFileSync(join(outDir, 'warm', 'sales-000999-000999-deadbeef.chk'), Buffer.from('orphan-bytes'));
    writeRelayIndex(relayDir, { chunks: {}, foto: { [deadSha]: `${deadSha}.bin` } });
    const dry = sweep(outDir, { dryRun: true, relayDir, deepFoto: true });
    assert.ok(dry.fotoOrphans.includes(`foto/${deadSha}.bin`), 'scan survives the torn chunk');
    // No relayDir: apply throws (ack unknowable) and deletes nothing.
    assert.throws(() => sweep(outDir, { dryRun: false, deepFoto: true }), /gc --apply requires relayDir/);
    assert.ok(existsSync(join(outDir, 'foto', `${deadSha}.bin`)), 'dead sidecar retained');
    assert.ok(existsSync(join(outDir, 'foto', `${refSha}.bin`)), 'referenced sidecar kept');
  });
  it('reports referenced shas with no sidecar file as fotoMissing', { timeout: 30_000 }, async () => {
    const dir = scratch('gcw-foto-missing');
    const { outDir, refSha } = await sealWithFoto(dir);
    unlinkSync(join(outDir, 'foto', `${refSha}.bin`));
    const r = sweep(outDir, { dryRun: true, deepFoto: true });
    assert.equal(r.fotoMissing.length, 1);
    assert.ok(r.fotoMissing[0].ref.includes(refSha));
    assert.ok(r.fotoMissing[0].chunk.endsWith('.chk'));
  });
});
describe('guard atomic tmp', () => {
  it('atomicWrite never reuses a pid-only tmp name', { timeout: 30_000 }, () => {
    const dir = scratch('guard-tmp-nonce');
    const dest = join(dir, 'w.json');
    const planted = `${dest}.tmp.${process.pid}`;
    writeFileSync(planted, 'stale');
    atomicWrite(dest, 'fresh');
    assert.equal(readFileSync(dest, 'utf8'), 'fresh');
    assert.equal(readFileSync(planted, 'utf8'), 'stale', 'pid-only tmp untouched: the real tmp carried a random suffix');
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.includes('.tmp.')),
      [`w.json.tmp.${process.pid}`],
      'no tmp litter left behind',
    );
  });
});
