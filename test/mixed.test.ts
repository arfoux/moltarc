// Mixed-corpus ratio bands: text 25-60x, mixed 6-12x (seeded, deterministic).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { generateMixedCorpus, measureArchive } from '../bench/mixed-corpus.js';
import { scratch } from './util.js';

describe('mixed corpus ratios', () => {
  it('repetitive text lands 25-60x, mixed lands 6-12x, blobs excluded', { timeout: 30_000 }, async () => {
    const dir = scratch('mixed');
    const corpus = generateMixedCorpus(dir, 3000, 7);
    assert.ok(corpus.blobBytes > 3000 * 4096 * 0.1, 'sidecar holds real blob bytes');
    const text = await measureArchive(corpus.textPath, join(dir, 'arch-text'));
    const mixed = await measureArchive(corpus.mixedPath, join(dir, 'arch-mixed'));
    console.log(`mixed-bench: text=${text.ratio.toFixed(1)}x mixed=${mixed.ratio.toFixed(1)}x blobs=${corpus.blobBytes}B excluded`);
    assert.ok(text.ratio >= 25 && text.ratio <= 60, `text band 25-60x, got ${text.ratio.toFixed(1)}x`);
    assert.ok(mixed.ratio >= 6 && mixed.ratio <= 12, `mixed band 6-12x, got ${mixed.ratio.toFixed(1)}x`);
    // Mandatory archive carries no blob bytes: warm << blob sidecar.
    assert.ok(mixed.warmBytes < corpus.blobBytes / 5, 'blob bytes excluded from mandatory archive');
  });
});
