// Dict benefit proof: same repetitive corpus, dict on vs off.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { measureDictDelta } from '../bench/dict-bench.js';
import { scratch } from './util.js';

describe('dict delta', () => {
  it('trained dict never loses to plain on repetitive text', async () => {
    const dir = scratch('dict-delta');
    const d = await measureDictDelta(dir, 6000, 7, 16 * 1024);
    console.log(`dict-delta: plain=${d.plain.warmBytes}B dict=${d.withDict.warmBytes}B saved=${d.savedPct.toFixed(1)}%`);
    assert.ok(d.withDict.chunks >= 2, 'multi-chunk corpus is where the dict can help');
    assert.ok(d.withDict.warmBytes <= d.plain.warmBytes, 'dict must not lose on repetitive text');
    assert.ok(d.savedPct >= 0, 'saving is real, not a promise');
    const dicts = readdirSync(join(dir, 'arch-dict', 'dicts'));
    assert.ok(dicts.length >= 1 && dicts.every((f: string) => f.endsWith('.dict')));
    assert.ok(!existsSync(join(dir, 'arch-plain', 'dicts')));
  });
});
