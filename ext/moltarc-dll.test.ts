// Acceptance: stock-dll proof — seal + find through the compiled extension.
import { Database } from 'bun:sqlite';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { scratch } from '../test/util.js';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
const here = dirname(fileURLToPath(import.meta.url));
const DLL = join(here, 'moltarc.dll');

const rows = [
  { device_id: 'dev0', seq: 1, ts: 1700000000001, id: 'trx-a', table: 'log', body: 'bayar nominal=15000 kasir=01' },
  { device_id: 'dev0', seq: 2, ts: 1700000000002, id: 'trx-b', table: 'log', body: 'bayar nominal=27500 kasir=02' },
  { device_id: 'dev0', seq: 3, ts: 1700000000003, id: 'trx-c', table: 'log', body: 'undo nominal=27500 alasan=salah-input' },
];

describe('moltarc native dll (subprocess-backed)', () => {
  test('seal then find via loaded extension', { timeout: 120_000 }, () => {
    const dir = scratch('dll');
    const hot = join(dir, 'hot.jsonl');
    writeFileSync(hot, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const out = join(dir, 'arc');
    const db = new Database(':memory:');
    db.loadExtension(DLL);
    const sealed = JSON.parse(
      (db.query('SELECT moltarc_seal(?, ?, ?) AS r').get(hot, out, 'log') as { r: string }).r,
    );
    expect(sealed.rowsSealed).toBe(3);
    const found = db.query('SELECT moltarc_find(?, ?) AS r').get(out, 'trx-b') as { r: string };
    expect(JSON.parse(found.r).body).toBe('bayar nominal=27500 kasir=02');
    const miss = db.query('SELECT moltarc_find(?, ?) AS r').get(out, 'trx-nope') as { r: null };
    expect(miss.r).toBeNull();
    db.close();
  });
});
