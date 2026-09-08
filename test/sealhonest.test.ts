// seal honesty: table-qualified dedupe, cheap foto gate, seal-side foto record,
// sidecar size enforcement, table-namespaced fallback ids.
// Each test FAILS pre-fix and PASSES post-fix.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { HotRow } from '../src/chunk.js';
import { normRow, quarantineFotoBody, readFotoSidecar, seal } from '../src/seal.js';
import { findTrx, matchRowId } from '../src/find.js';
import { scratch } from './util.js';

const BASE = 1_700_000_000_000;
const FOTO_REF_RE = /^foto:sha256:([0-9a-f]{64}):size=(\d+)$/;

function bigBody(bytes = 300 * 1024): { raw: Buffer; b64: string } {
  const raw = randomBytes(bytes);
  return { raw, b64: raw.toString('base64') };
}

describe('seal honesty', () => {
  it('cross-table same device+seq rows both survive (table:device:seq key)', { timeout: 60_000 }, async () => {
    const dir = scratch('sealhonest-dedupe');
    const hotDb = join(dir, 'hot.jsonl');
    const lines = [
      JSON.stringify({ device_id: 'dev0', seq: 1, ts: BASE, id: 'a-1', table: 'sales', body: 'sales row' }),
      JSON.stringify({ device_id: 'dev0', seq: 1, ts: BASE, id: 'b-1', table: 'returns', body: 'returns row' }),
    ];
    writeFileSync(hotDb, `${lines.join('\n')}\n`);
    const outDir = join(dir, 'arch');
    const r = await seal({ hotDb, outDir });
    // Pre-fix (device:seq key) the second table's row overwrites the first.
    assert.equal(r.rowsSealed, 2);
    const a = findTrx({ outDir, trxId: 'a-1' });
    const b = findTrx({ outDir, trxId: 'b-1' });
    assert.equal(a.row.body, 'sales row');
    assert.equal(a.row.table, 'sales');
    assert.equal(b.row.body, 'returns row');
    assert.equal(b.row.table, 'returns');
  });

  it('same-key overwrite keeps last and counts replaced', { timeout: 60_000 }, async () => {
    const dir = scratch('sealhonest-replace');
    const hotDb = join(dir, 'hot.jsonl');
    const lines = [
      JSON.stringify({ device_id: 'dev0', seq: 1, ts: BASE, id: 'a-1', table: 'sales', body: 'first' }),
      JSON.stringify({ device_id: 'dev0', seq: 1, ts: BASE + 1, id: 'a-1', table: 'sales', body: 'second' }),
    ];
    writeFileSync(hotDb, `${lines.join('\n')}\n`);
    const outDir = join(dir, 'arch');
    const r = await seal({ hotDb, outDir });
    assert.equal(r.rowsSealed, 1);
    assert.equal(r.rowsReplaced, 1);
    assert.equal(findTrx({ outDir, trxId: 'a-1' }).row.body, 'second');
  });

  it('foto gate: short and non-foto bodies skip it, oversize base64 quarantines', { timeout: 60_000 }, async () => {
    const dir = scratch('sealhonest-gate');
    const outDir = join(dir, 'arch');
    // Pre-fix every row pays strip+regex+decode+re-encode; the cheap length
    // check first routes only bodies >= ~341K chars into the full gate.
    assert.equal(quarantineFotoBody(outDir, 'TRANSACTION OK amount=15000'), null);
    assert.equal(quarantineFotoBody(outDir, 'x'.repeat(400)), null);
    assert.equal(quarantineFotoBody(outDir, 'not base64 at all !!!!'.repeat(30)), null);
    // Slow path stays honest: non-canonical bulk fails strict re-encode.
    assert.equal(quarantineFotoBody(outDir, `${'Y'.repeat(349_996)}AB==`), null);
    const { raw, b64 } = bigBody();
    const ref = quarantineFotoBody(outDir, b64);
    assert.match(ref ?? '', FOTO_REF_RE);
    const size = Number(FOTO_REF_RE.exec(ref ?? '')?.[2]);
    assert.equal(size, raw.length);
    // Raw pre-check never skips a body the full gate would take: leading
    // whitespace still routes through strip into the same ref.
    assert.equal(quarantineFotoBody(outDir, `  \n${b64}`), ref);
  });

  it('seal records quarantined foto refs for verify/ship/sweep', { timeout: 60_000 }, async () => {
    const dir = scratch('sealhonest-record');
    const hotDb = join(dir, 'hot.jsonl');
    const { b64 } = bigBody();
    const lines = [
      JSON.stringify({ device_id: 'pos-01', seq: 1, ts: BASE, id: 't-1', table: 'sales', body: 'small text' }),
      JSON.stringify({ device_id: 'cam-01', seq: 2, ts: BASE + 1, id: 'f-1', table: 'foto', body: b64 }),
    ];
    writeFileSync(hotDb, `${lines.join('\n')}\n`);
    const outDir = join(dir, 'arch');
    const r = await seal({ hotDb, outDir });
    // Pre-fix SealResult carries no foto record: nothing downstream to audit.
    assert.equal(r.fotoQuarantined.length, 1);
    assert.match(r.fotoQuarantined[0], FOTO_REF_RE);
    assert.equal(findTrx({ outDir, trxId: 'f-1' }).row.body, r.fotoQuarantined[0]);
    // A seal with no foto rows records an empty list, never undefined.
    const r2 = await seal({ hotDb, outDir });
    assert.deepEqual(r2.fotoQuarantined, []);
  });

  it('truncated sidecar throws, whole returns, missing stays distinct', { timeout: 60_000 }, async () => {
    const dir = scratch('sealhonest-sidecar');
    const hotDb = join(dir, 'hot.jsonl');
    const { raw, b64 } = bigBody();
    writeFileSync(hotDb, `${JSON.stringify({ device_id: 'cam-01', seq: 1, ts: BASE, id: 'f-1', table: 'foto', body: b64 })}\n`);
    const outDir = join(dir, 'arch');
    await seal({ hotDb, outDir });
    const ref = findTrx({ outDir, trxId: 'f-1' }).row.body;
    const sha = FOTO_REF_RE.exec(ref)?.[1] ?? '';
    const bin = join(outDir, 'foto', `${sha}.bin`);
    // Whole sidecar reads back bit-exact.
    assert.ok(readFotoSidecar(outDir, ref).equals(raw));
    // Pre-fix a truncated sidecar decodes as silently wrong bytes.
    writeFileSync(bin, raw.subarray(0, 100));
    assert.throws(() => readFotoSidecar(outDir, ref), /size mismatch/);
    // Missing sidecar throws a different error: callers tell trunc from gone.
    unlinkSync(bin);
    assert.throws(() => readFotoSidecar(outDir, ref), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.ok(!/size mismatch/.test(e.message), `trunc vs missing must differ: ${e.message}`);
      return true;
    });
  });

  it('matchRowId: exact id plus table-namespaced fallback', { timeout: 30_000 }, () => {
    const row: HotRow = { device_id: 'dev0', seq: 2, ts: BASE, id: 'legacy-9', table: 'foto', body: 'b' };
    // Pre-fix find matches bare ids only: a qualified lookup never resolves.
    assert.equal(matchRowId(row, 'legacy-9'), true);
    assert.equal(matchRowId(row, 'foto:dev0:2'), true);
    assert.equal(matchRowId(row, 'sales:dev0:2'), false);
    assert.equal(matchRowId(row, 'unrelated'), false);
  });

  it('no-id rows across tables seal with distinct namespaced ids, each findable', { timeout: 60_000 }, async () => {
    // Seal-side half of the contract: the fallback id carries the table so
    // same device+seq rows from two tables never share an identity.
    assert.equal(normRow({ device_id: 'd', seq: 1, ts: BASE, table: 't' }, 'log')?.id, 't:d:1');
    const dir = scratch('sealhonest-names');
    const hotDb = join(dir, 'hot.jsonl');
    const lines = [
      JSON.stringify({ device_id: 'dev0', seq: 1, ts: BASE, table: 'sales', body: 'sales body' }),
      JSON.stringify({ device_id: 'dev0', seq: 1, ts: BASE, table: 'returns', body: 'returns body' }),
    ];
    writeFileSync(hotDb, `${lines.join('\n')}\n`);
    const outDir = join(dir, 'arch');
    const r = await seal({ hotDb, outDir });
    assert.equal(r.rowsSealed, 2);
    const a = findTrx({ outDir, trxId: 'sales:dev0:1' });
    const b = findTrx({ outDir, trxId: 'returns:dev0:1' });
    assert.equal(a.row.body, 'sales body');
    assert.equal(b.row.body, 'returns body');
  });
});
