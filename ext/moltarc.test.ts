import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { scratch } from '../test/util.js';
import { join } from 'path';
import { decodeChunk } from '../src/chunk.js';
import { FIND_ARITY, FIND_NAME, SEAL_NAME, moltarcFind, moltarcSeal } from './moltarc.js';

const rows = [
  { device_id: 'dev0', seq: 1, ts: 1700000000001, id: 'trx-a', table: 'log', body: 'entry value=15000 device=01' },
  { device_id: 'dev0', seq: 2, ts: 1700000000002, id: 'trx-b', table: 'log', body: 'entry value=27500 device=02' },
  { device_id: 'dev0', seq: 3, ts: 1700000000003, id: 'trx-c', table: 'log', body: 'undo value=27500 reason=wrong-input' },
];

function fixture(): { hot: string; out: string } {
  const dir = scratch('ext');
  const hot = join(dir, 'hot.jsonl');
  writeFileSync(hot, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { hot, out: join(dir, 'arc') };
}

describe('moltarc sqlite extension reference (ts)', () => {
  test('sql contract names match the c abi plan', () => {
    expect(FIND_NAME).toBe('moltarc_find');
    expect(FIND_ARITY).toBe(2);
    expect(SEAL_NAME).toBe('moltarc_seal');
  });

  test('seal then select-equivalent find returns the sealed row', async () => {
    const { hot, out } = fixture();
    // SELECT moltarc_seal(hotDb, outDir, table)
    const sealed = JSON.parse(await moltarcSeal(hot, out, 'log'));
    expect(sealed.rowsSealed).toBe(3);
    expect(sealed.chunks.length).toBeGreaterThanOrEqual(1);

    // SELECT moltarc_find(outDir, trxId)
    const raw = moltarcFind(out, 'trx-b');
    expect(raw).not.toBeNull();
    const row = JSON.parse(raw as string);
    expect(row.id).toBe('trx-b');
    expect(row.body).toBe('entry value=27500 device=02');
    expect(row.seq).toBe(2);
    expect(typeof row.chunk).toBe('string');
    expect(row.chunk.endsWith('.chk')).toBe(true);
  });

  test('find is read-only and misses return null (sql null)', async () => {
    const { hot, out } = fixture();
    await moltarcSeal(hot, out, 'log');
    const before = readdirSync(join(out, 'warm')).sort();
    expect(moltarcFind(out, 'trx-nope')).toBeNull();
    expect(moltarcFind(out, '')).toBeNull();
    expect(readdirSync(join(out, 'warm')).sort()).toEqual(before);
  });

  test('no format fork: extension row matches canonical chunk decode', async () => {
    const { hot, out } = fixture();
    await moltarcSeal(hot, out, 'log');
    const row = JSON.parse(moltarcFind(out, 'trx-c') as string);
    const buf = readFileSync(join(out, 'warm', row.chunk));
    const { rows: decoded } = decodeChunk(buf);
    const canonical = decoded.find((r) => r.id === 'trx-c');
    expect(canonical?.body).toBe(row.body);
    expect(canonical?.body).toBe('undo value=27500 reason=wrong-input');
  });

  test('seal is idempotent: re-seal seals zero rows', async () => {
    const { hot, out } = fixture();
    await moltarcSeal(hot, out, 'log');
    const again = JSON.parse(await moltarcSeal(hot, out, 'log'));
    expect(again.rowsSealed).toBe(0);
    expect(again.rowsSkipped).toBe(3);
    expect(existsSync(hot)).toBe(true); // input never deleted
  });
});
