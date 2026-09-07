// readonly auditor proof: mutations refuse loud, reads work fully.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { openArchiveReadOnly } from '../src/readonly.js';
import { scratch, writeHotLog } from './util.js';

describe('readonly auditor mode', () => {
  it('refuses every mutating op while find/verify/status work', { timeout: 30_000 }, async () => {
    const root = scratch('readonly');
    const outDir = join(root, 'arc');
    const { hotDb, ids } = writeHotLog(root, { rows: 200 });
    const sealed = await seal({ hotDb, outDir });
    assert.ok(sealed.chunks.length > 0, 'setup sealed at least one chunk');

    const ro = openArchiveReadOnly(outDir);
    const warmBefore = readdirSync(join(outDir, 'warm')).sort();

    // Reads work fully through the handle.
    const found = ro.find(ids[0]);
    assert.equal(found.row.id, ids[0]);
    const v = ro.verify();
    assert.equal(v.ok, true);
    assert.ok(v.items.length > 0);
    const full = ro.verifyFull();
    assert.equal(full.ok, true);
    const st = ro.status();
    assert.equal(st.chunks, sealed.chunks.length);

    // Refusal list is derived from the handle src exports (not handwritten),
    // so a new mutating stub added to src/readonly.ts fails below until it
    // is classified here. Known reads stay callable; everything else refuses.
    const READ_OPS: Record<string, true> = { dir: true, find: true, verify: true, verifyFull: true, status: true };
    const mutating = Object.keys(ro).filter((k) => !READ_OPS[k]);
    assert.deepEqual(mutating.sort(), ['seal', 'ship', 'forget', 'sweep', 'sweepCold', 'repair', 'repairByHash', 'quarantine', 'merge', 'migrate', 'syncFromPeer', 'casGc', 'packBundle'].sort());
    for (const op of mutating) {
      assert.throws(() => (ro[op as keyof typeof ro] as (...a: unknown[]) => never)(), /read-only/, `${op} must refuse`);
      assert.throws(() => (ro[op as keyof typeof ro] as (...a: unknown[]) => never)({ outDir }), new RegExp(op), `${op} error names the op`);
    }

    // Refused mutations wrote nothing: archive untouched and still readable.
    assert.deepEqual(readdirSync(join(outDir, 'warm')).sort(), warmBefore);
    assert.equal(ro.verify().ok, true);
    assert.equal(ro.find(ids[ids.length - 1]).row.id, ids[ids.length - 1]);
  });
});
