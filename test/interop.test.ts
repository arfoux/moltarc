// Interop: raw fielog ledger.log (entry/undo events, value payload)
// seals with no manual conversion; one entry reads back intact.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { seal, normRow } from '../src/seal.js';
import { findTrx } from '../src/find.js';
import { scratch } from './util.js';

function writeLedgerLog(dir: string, events: number): { hotDb: string; ids: string[] } {
  const base = 1_700_000_000_000;
  const lines: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < events; i++) {
    const seq = i + 1;
    if (i % 9 === 8) {
      // undo references an earlier trx; its own row keeps device:seq identity.
      const ref = `trx-${String(seq - 4).padStart(8, '0')}`;
      lines.push(JSON.stringify({
        device_id: 'device-01', seq, ts: base + i * 30_000, event: 'undo',
        ref, reason: 'wrong-input', actor: 'agus',
      }));
    } else {
      const id = `trx-${String(seq).padStart(8, '0')}`;
      ids.push(id);
      lines.push(JSON.stringify({
        device_id: 'device-01', seq, ts: base + i * 30_000, type: 'entry',
        trx: id, value: 5000 + ((i * 37) % 20) * 10000, actor: 'agus',
      }));
    }
  }
  const hotDb = join(dir, 'ledger.log');
  writeFileSync(hotDb, `${lines.join('\n')}\n`);
  return { hotDb, ids };
}

describe('fielog interop', () => {
  it('normRow handles entry/undo events with value payload', { timeout: 30_000 }, () => {
    const entry = normRow({ device_id: 'device-01', seq: 3, type: 'entry', trx: 'trx-00000003', value: 55000, actor: 'agus' }, 'log');
    assert.equal(entry?.table, 'entry');
    assert.equal(entry?.id, 'trx-00000003');
    assert.ok((entry?.body ?? '').includes('value=55000'));
    const undo = normRow({ device_id: 'device-01', seq: 9, event: 'undo', ref: 'trx-00000005', reason: 'wrong-input' }, 'log');
    assert.equal(undo?.table, 'undo');
    assert.ok((undo?.body ?? '').includes('ref=trx-00000005'));
  });

  it('ledger.log seals directly and one entry reads back', { timeout: 30_000 }, async () => {
    const dir = scratch('interop');
    const { hotDb, ids } = writeLedgerLog(dir, 90);
    const outDir = join(dir, 'archive');
    const r = await seal({ hotDb, outDir });
    assert.equal(r.rowsSealed, 90);

    const target = ids[40];
    const found = findTrx({ outDir, trxId: target });
    assert.equal(found.row.id, target);
    assert.equal(found.row.table, 'entry');
    assert.ok(found.row.body.includes('value='));
    assert.equal(found.chunksFetched, 1);
  });
});
