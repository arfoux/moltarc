// ship waste fixes: one hash per chunk, stat resume, batched index, named journals, explicit missing.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { sendChunked, ship, readRelayIndex } from '../src/ship.js';
import { sha256hex } from '../src/chunk.js';
import { scratch } from './util.js';

function fakeArchive(dir: string, files: { name: string; size: number; seed: number }[]): { outDir: string; relayDir: string } {
  const outDir = join(dir, 'archive');
  const relayDir = join(dir, 'relay');
  mkdirSync(join(outDir, 'warm'), { recursive: true });
  const chunks = files.map((f, i) => {
    const buf = Buffer.alloc(f.size);
    for (let j = 0; j < f.size; j++) buf[j] = (f.seed + j * 31) & 0xff;
    writeFileSync(join(outDir, 'warm', f.name), buf);
    return {
      file: f.name, table: 'events', seqMin: i + 1, seqMax: i + 1,
      tsMin: 1, tsMax: 1, rows: 1, bytes: f.size, sha256: sha256hex(buf),
      crc32c: 0, dictId: 0, codec: 0, minKey: '', maxKey: '', bloom: '',
    };
  });
  const manifest = { version: 1, createdAt: new Date(0).toISOString(), chunks, cold: [] };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  return { outDir, relayDir };
}

describe('ship waste fixes', () => {
  it('journals one source hash and reuses it for resume and verify', { timeout: 30_000 }, async () => {
    const dir = scratch('ship-hash-once');
    const src = join(dir, 'a.chk');
    const data = Buffer.alloc(4096);
    for (let i = 0; i < data.length; i++) data[i] = (i * 17) & 0xff;
    writeFileSync(src, data);
    const dst = join(dir, 'relay', 'a.chk');
    const state = join(dir, 'relay', '.ship-state-a.json');
    const opts = { blockBytes: 512, maxRetries: 0, baseDelayMs: 1, failAtBytes: 1500, sleep: async () => {} };
    await assert.rejects(sendChunked(src, dst, state, opts), /injected transport failure/);
    const journal = JSON.parse(readFileSync(state, 'utf8')) as { offset: number; sha256: string };
    assert.ok(journal.offset > 0, 'crash leaves forward progress');
    assert.equal(journal.sha256, sha256hex(data), 'journal carries the single source hash');
    const done = await sendChunked(src, dst, state, { ...opts, failAtBytes: undefined });
    assert.equal(done.resumed, true);
    assert.deepEqual(readFileSync(dst), data);
    assert.ok(!existsSync(state), 'journal cleaned after verified copy');
  });

  it('resumes from partial bytes via stat without rereading the whole dst', { timeout: 30_000 }, async () => {
    const dir = scratch('ship-stat-resume');
    const src = join(dir, 'b.chk');
    const data = Buffer.alloc(4096);
    for (let i = 0; i < data.length; i++) data[i] = (i * 29 + 7) & 0xff;
    writeFileSync(src, data);
    const dst = join(dir, 'relay', 'b.chk');
    mkdirSync(join(dir, 'relay'), { recursive: true });
    writeFileSync(dst, data.subarray(0, 1024));
    const state = join(dir, 'relay', '.ship-state-b.json');
    writeFileSync(state, JSON.stringify({ offset: 1024, sha256: sha256hex(data) }));
    const r = await sendChunked(src, dst, state, {
      blockBytes: 512, maxRetries: 5, baseDelayMs: 1, sleep: async () => {},
    });
    assert.equal(r.resumed, true);
    assert.deepEqual(readFileSync(dst), data);
  });

  it('saves the relay index once: crash keeps partial chunks out of the index', { timeout: 30_000 }, async () => {
    const dir = scratch('ship-index-once');
    const { outDir, relayDir } = fakeArchive(dir, [
      { name: 'events-000001-000001-aa01.chk', size: 600, seed: 3 },
      { name: 'events-000002-000002-bb02.chk', size: 6000, seed: 11 },
    ]);
    await assert.rejects(
      ship({ outDir, relayDir, blockBytes: 64, failAtBytes: 601, maxRetries: 0, baseDelayMs: 1 }),
      /injected transport failure/,
    );
    assert.ok(existsSync(join(relayDir, 'chunks', 'events-000001-000001-aa01.chk')), 'first chunk bytes landed before the crash');
    assert.deepEqual(readRelayIndex(relayDir).chunks, {}, 'no partial index entry without the batched save');
  });

  it('names the journal after the chunk and rejects foreign journals', { timeout: 30_000 }, async () => {
    const dir = scratch('ship-state-name');
    const { outDir, relayDir } = fakeArchive(dir, [
      { name: 'events-000007-000007-cc07.chk', size: 1000, seed: 5 },
    ]);
    await assert.rejects(
      ship({ outDir, relayDir, blockBytes: 64, failAtBytes: 100, maxRetries: 0, baseDelayMs: 1 }),
      /injected transport failure/,
    );
    const journals = readdirSync(relayDir).filter((f) => f.startsWith('.ship-state-'));
    assert.equal(journals.length, 1, 'one journal per interrupted chunk');
    assert.ok(journals[0].includes('events-000007-000007-cc07.chk'), `journal names the chunk: ${journals[0]}`);

    // Foreign journal (right hash, wrong chunk) is ignored; legacy journal without a name still resumes.
    const src = join(outDir, 'warm', 'events-000007-000007-cc07.chk');
    const data = readFileSync(src);
    const dst = join(dir, 'dst.chk');
    const state = join(dir, 's.json');
    writeFileSync(state, JSON.stringify({ offset: data.length, sha256: sha256hex(data), file: 'other.chk' }));
    const cold = await sendChunked(src, dst, state, {
      blockBytes: 128, maxRetries: 0, baseDelayMs: 1, sleep: async () => {}, chunkFile: 'events-000007-000007-cc07.chk',
    });
    assert.equal(cold.resumed, false, 'foreign journal never resumes');
    assert.deepEqual(readFileSync(dst), data);

    const dst2 = join(dir, 'dst2.chk');
    const state2 = join(dir, 's2.json');
    writeFileSync(dst2, data.subarray(0, 256));
    writeFileSync(state2, JSON.stringify({ offset: 256, sha256: sha256hex(data) }));
    const legacy = await sendChunked(src, dst2, state2, {
      blockBytes: 128, maxRetries: 0, baseDelayMs: 1, sleep: async () => {}, chunkFile: 'events-000007-000007-cc07.chk',
    });
    assert.equal(legacy.resumed, true, 'legacy journal without a name still resumes');
    assert.deepEqual(readFileSync(dst2), data);
  });

  it('reports a missing warm source as an explicit missing entry, never a silent skip', { timeout: 30_000 }, async () => {
    const dir = scratch('ship-missing');
    const { outDir, relayDir } = fakeArchive(dir, [
      { name: 'events-000001-000001-aa01.chk', size: 700, seed: 1 },
      { name: 'events-000002-000002-bb02.chk', size: 800, seed: 2 },
    ]);
    const victim = 'events-000002-000002-bb02.chk';
    unlinkSync(join(outDir, 'warm', victim));
    const r = await ship({ outDir, relayDir, baseDelayMs: 1 });
    assert.deepEqual(r.missing, [victim], 'missing warm source is an explicit entry');
    assert.ok(r.skipped.includes(victim), 'legacy skipped accounting preserved');
    assert.deepEqual(r.sent, ['events-000001-000001-aa01.chk'], 'survivors still ship');
    assert.equal(r.sent.length + r.skipped.length, 2, 'every chunk accounted for');
  });

  it('resumes a 30MB file after a mid-copy kill with identical bytes', { timeout: 120_000 }, async () => {
    const dir = scratch('ship-30mb-resume');
    const size = 30 * 1024 * 1024;
    const src = join(dir, 'big.chk');
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buf[i] = (3 + i * 31) & 0xff;
    writeFileSync(src, buf);
    const hex = sha256hex(buf);
    const dst = join(dir, 'relay', 'big.chk');
    const state = join(dir, 'relay', '.ship-state-big.json');
    const attempt = { blockBytes: 64 * 1024, maxRetries: 0, baseDelayMs: 1, failAtBytes: 15 * 1024 * 1024, sleep: async () => {} };
    await assert.rejects(sendChunked(src, dst, state, attempt), /injected transport failure/);
    const journal = JSON.parse(readFileSync(state, 'utf8')) as { offset: number; sha256: string };
    assert.ok(journal.offset > 0 && journal.offset <= size, `kill leaves partial progress, got ${journal.offset}`);
    assert.equal(journal.sha256, hex, 'journal carries the source hash');
    const done = await sendChunked(src, dst, state, { ...attempt, failAtBytes: undefined });
    assert.equal(done.resumed, true, 'second run resumes the killed copy');
    assert.equal(done.bytes, size);
    const relayed = readFileSync(dst);
    assert.deepEqual(relayed, readFileSync(src), 'relay bytes equal src after resume');
    assert.equal(sha256hex(relayed), hex);
    assert.ok(!existsSync(state), 'journal cleaned after verified copy');
  });
});
