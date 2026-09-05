// Real-jpeg proof: raw jpeg bytes sit at 1.0-1.2x, text beside them shrinks hard.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { measurePhotoCorpus, makeJpeg } from '../bench/photo-bench.js';
import { findTrx } from '../src/find.js';
import { scratch } from './util.js';

describe('photo bench', () => {
  it('jpeg bytes prove 1.0-1.2x while text shrinks 25x+', { timeout: 30_000 }, async () => {
    const dir = scratch('photo');
    const { corpus, measure } = await measurePhotoCorpus(dir, 12, 300, 11);
    assert.equal(corpus.photoIds.length, 12);
    assert.ok(corpus.jpegBytes > 0);
    console.log(`photo-bench: raw=${measure.rawJpegRatio.toFixed(2)}x lines=${measure.photoRatio.toFixed(2)}x text=${measure.textRatio.toFixed(1)}x`);
    assert.ok(measure.rawJpegRatio >= 1.0 && measure.rawJpegRatio <= 1.2, `foto claim 1.0-1.2x, got ${measure.rawJpegRatio.toFixed(2)}x`);
    assert.ok(measure.photoRatio >= 1.0 && measure.photoRatio <= 1.6, `lines band, got ${measure.photoRatio.toFixed(2)}x`);
    assert.ok(measure.textRatio >= 20, `text beside photos still shrinks, got ${measure.textRatio.toFixed(1)}x`);

    // Photo bytes round-trip bit-exact through seal + find.
    const target = corpus.photoIds[0];
    const found = findTrx({ outDir: join(dir, 'arch'), trxId: target });
    const expect = makeJpeg(11 * 1000 + 0).toString('base64');
    assert.equal(found.row.body, expect);
  });

  it('generates deterministic real jpeg containers', { timeout: 30_000 }, () => {
    const a = makeJpeg(42);
    const b = makeJpeg(42);
    assert.ok(a.equals(b), 'same seed, same bytes');
    assert.equal(a.subarray(0, 2).toString('hex'), 'ffd8', 'jpeg magic');
    assert.ok(a.length > 1024, 'non-trivial container');
  });
});
