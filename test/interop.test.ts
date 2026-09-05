// Interop: raw fielog kasir.log (bayar/undo events, nominal payload)
// seals with no manual conversion; one struk finds back intact.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { seal, normRow } from '../src/seal.js';
import { findTrx } from '../src/find.js';
import { scratch } from './util.js';

function writeKasirLog(dir: string, events: number): { hotDb: string; ids: string[] } {
  const base = 1_700_000_000_000;
  const lines: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < events; i++) {
    const seq = i + 1;
    if (i % 9 === 8) {
      // undo references an earlier trx; its own row keeps device:seq identity.
      const ref = `trx-${String(seq - 4).padStart(8, '0')}`;
      lines.push(JSON.stringify({
        device_id: 'kasir-01', seq, ts: base + i * 30_000, event: 'undo',
        ref, alasan: 'salah input', kasir: 'agus',
      }));
    } else {
      const id = `trx-${String(seq).padStart(8, '0')}`;
      ids.push(id);
      lines.push(JSON.stringify({
        device_id: 'kasir-01', seq, ts: base + i * 30_000, type: 'bayar',
        trx: id, nominal: 5000 + ((i * 37) % 20) * 10000, kasir: 'agus',
      }));
    }
  }
  const hotDb = join(dir, 'kasir.log');
  writeFileSync(hotDb, `${lines.join('\n')}\n`);
  return { hotDb, ids };
}

describe('fielog interop', () => {
  it('normRow handles bayar/undo events with nominal payload', () => {
    const bayar = normRow({ device_id: 'kasir-01', seq: 3, type: 'bayar', trx: 'trx-00000003', nominal: 55000, kasir: 'agus' }, 'log');
    assert.equal(bayar?.table, 'bayar');
    assert.equal(bayar?.id, 'trx-00000003');
    assert.ok((bayar?.body ?? '').includes('nominal=55000'));
    const undo = normRow({ device_id: 'kasir-01', seq: 9, event: 'undo', ref: 'trx-00000005', alasan: 'salah input' }, 'log');
    assert.equal(undo?.table, 'undo');
    assert.ok((undo?.body ?? '').includes('ref=trx-00000005'));
  });

  it('kasir.log seals directly and one struk finds back', async () => {
    const dir = scratch('interop');
    const { hotDb, ids } = writeKasirLog(dir, 90);
    const outDir = join(dir, 'archive');
    const r = await seal({ hotDb, outDir });
    assert.equal(r.rowsSealed, 90);

    const target = ids[40];
    const found = findTrx({ outDir, trxId: target });
    assert.equal(found.row.id, target);
    assert.equal(found.row.table, 'bayar');
    assert.ok(found.row.body.includes('nominal='));
    assert.equal(found.chunksFetched, 1);
  });
});
