// Dict benefit proof: same repetitive corpus, dict on vs off.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { measureDictDelta } from '../bench/dict-bench.js';
import { scratch } from './util.js';

describe('dict delta', () => {
  it('trained dict never loses to plain on repetitive text', { timeout: 30_000 }, async () => {
    const dir = scratch('dict-delta');
    const d = await measureDictDelta(dir, 6000, 7, 16 * 1024);
    console.log(`dict-delta: plain=${d.plain.warmBytes}B dict=${d.withDict.warmBytes}B saved=${d.savedPct.toFixed(1)}%`);
    assert.ok(d.withDict.chunks >= 2, 'multi-chunk corpus is where the dict can help');
    assert.ok(d.withDict.warmBytes <= d.plain.warmBytes, 'dict must not lose on repetitive text');
    // Strictly positive: same repetitive corpus on both sides, so the only
    // difference is the shared trained dict; with >=2 chunks every chunk
    // reuses it instead of starting zstd cold, which must save real bytes.
    assert.ok(d.savedPct > 0, `expected real saving, got ${d.savedPct.toFixed(1)}%`);
    const dicts = readdirSync(join(dir, 'arch-dict', 'dicts'));
    assert.ok(dicts.length >= 1 && dicts.every((f: string) => f.endsWith('.dict')));
    assert.ok(!existsSync(join(dir, 'arch-plain', 'dicts')));
  });
});
