// Synthetic repetitive log must shrink hard: columnar delta/RLE/dict + zstd.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { decodeHeader, HEADER_SIZE } from '../src/chunk.js';
import { scratch, writeHotLog } from './util.js';

describe('seal shrink ratio', () => {
  it('repetitive log compresses >=10x with 64B UMK1 headers', async () => {
    const dir = scratch('shrink');
    const { hotDb, inputBytes } = writeHotLog(dir, { rows: 20000 });
    const outDir = join(dir, 'archive');
    const r = await seal({ hotDb, outDir });
    assert.ok(r.chunks.length >= 1, 'sealed at least one chunk');
    assert.equal(r.rowsSealed, 20000);
    // 64B header contract on every chunk.
    for (const c of r.chunks) {
      const buf = readFileSync(c);
      assert.equal(buf.subarray(0, 4).toString('ascii'), 'UMK1');
      const h = decodeHeader(buf);
      assert.equal(HEADER_SIZE, 64);
      assert.equal(h.bodyLen, buf.length - HEADER_SIZE);
      assert.ok(h.rows > 0);
    }
    const warmBytes = readdirSync(join(outDir, 'warm'))
      .filter((f) => f.endsWith('.chk'))
      .reduce((n, f) => n + statSync(join(outDir, 'warm', f)).size, 0);
    const ratio = inputBytes / warmBytes;
    console.log(`shrink: input=${inputBytes}B warm=${warmBytes}B ratio=${ratio.toFixed(1)}x chunks=${r.chunks.length}`);
    assert.ok(ratio >= 10, `expected >=10x on repetitive log, got ${ratio.toFixed(1)}x`);
    // Manifest dual copy + watermark written.
    assert.ok(existsSync(join(outDir, 'manifest.json')));
    assert.ok(existsSync(join(outDir, 'manifest.bak.json')));
    assert.equal(readFileSync(join(outDir, 'sealed_upto_seq'), 'utf8').trim(), '20000');
    // Idempotent re-seal: nothing new, input never deleted.
    const r2 = await seal({ hotDb, outDir });
    assert.equal(r2.chunks.length, 0);
    assert.equal(r2.rowsSkipped, 20000);
    assert.ok(existsSync(hotDb), 'hot log never deleted');
  });
});
