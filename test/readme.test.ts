// readme cross-check: every SLA number must come from a producing bench.
// The three marker sections must equal the tables regenerated from
// bench/measured.json, and every bold number in the Honest SLA summary must
// match a measured value. Hand-edited ratios fail here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { slaTable } from '../bench/mixed-corpus.js';
import { photoTable } from '../bench/photo-bench.js';
import { dictTable } from '../bench/dict-bench.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

interface Measured {
  mixed: Record<string, number | string>;
  photo: Record<string, number | string>;
  dict: Record<string, number | string>;
}

function loadMeasured(): Measured {
  let raw: string;
  try {
    raw = readFileSync(join(root, 'bench', 'measured.json'), 'utf8');
  } catch {
    assert.fail('bench/measured.json missing: run the benches with --write-readme first');
  }
  const m = JSON.parse(raw) as Partial<Measured>;
  for (const key of ['mixed', 'photo', 'dict'] as const) {
    assert.ok(m[key], `bench/measured.json missing ${key}: re-run that bench with --write-readme`);
  }
  return m as Measured;
}

function flat(s: string): string {
  return s.replace(/\r\n/g, '\n').trim();
}

function section(readme: string, start: string, end: string): string {
  const a = readme.indexOf(start);
  const b = readme.indexOf(end);
  assert.ok(a >= 0 && b > a, `README missing ${start} section`);
  return flat(readme.slice(a, b + end.length));
}
describe('readme numbers come from benches', () => {
  it('marker tables equal tables regenerated from measured.json', { timeout: 30_000 }, () => {
    const m = loadMeasured();
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const num = (v: number | string): number => Number(v);

    const text = {
      inputBytes: num(m.mixed.textInputBytes), warmBytes: num(m.mixed.textWarmBytes),
      ratio: num(m.mixed.textRatio), chunks: num(m.mixed.textChunks),
    };
    const mixed = {
      inputBytes: num(m.mixed.mixedInputBytes), warmBytes: num(m.mixed.mixedWarmBytes),
      ratio: num(m.mixed.mixedRatio), chunks: num(m.mixed.mixedChunks),
    };
    assert.equal(
      section(readme, '<!-- SLA-MEASURED-START -->', '<!-- SLA-MEASURED-END -->'),
      slaTable(text, mixed, num(m.mixed.blobBytes)).trim(),
    );

    const photo = {
      photoRatio: num(m.photo.photoRatio), textRatio: num(m.photo.textRatio),
      rawJpegRatio: num(m.photo.rawJpegRatio),
      photoWarm: num(m.photo.photoWarm), textWarm: num(m.photo.textWarm),
    };
    assert.equal(
      section(readme, '<!-- PHOTO-MEASURED-START -->', '<!-- PHOTO-MEASURED-END -->'),
      photoTable(photo, num(m.photo.jpegBytes)).trim(),
    );

    const dict = {
      plain: { inputBytes: 0, warmBytes: num(m.dict.plainWarm), ratio: num(m.dict.plainRatio), chunks: 0 },
      withDict: { inputBytes: 0, warmBytes: num(m.dict.dictWarm), ratio: num(m.dict.dictRatio), chunks: 0 },
      savedBytes: num(m.dict.savedBytes), savedPct: num(m.dict.savedPct),
    };
    assert.equal(
      section(readme, '<!-- DICT-MEASURED-START -->', '<!-- DICT-MEASURED-END -->'),
      dictTable(dict).trim(),
    );
  });

  it('honest sla has no planning bands and every number names its bench', { timeout: 30_000 }, () => {
    const m = loadMeasured();
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const start = readme.indexOf('## Honest SLA');
    assert.ok(start >= 0, 'README missing Honest SLA section');
    const next = readme.indexOf('\n## ', start + 1);
    const block = readme.slice(start, next < 0 ? readme.length : next);
    assert.ok(!/\bband\b/i.test(block), 'planning band in Honest SLA: quote the measured ratio only');

    const bullets = block.split('\n').filter((l) => l.startsWith('- '));
    assert.ok(bullets.length >= 4, 'Honest SLA must summarize text/mixed/photo/dict');
    for (const b of bullets) {
      assert.ok(b.includes('bench/'), `bullet names no producing bench: ${b}`);
    }

    const measured = new Set([
      String(m.mixed.textRatio), String(m.mixed.mixedRatio),
      String(m.photo.photoRatio), String(m.photo.rawJpegRatio), String(m.photo.textRatio),
      String(m.dict.plainRatio), String(m.dict.dictRatio), String(m.dict.savedPct),
    ]);
    const bolds = [...block.matchAll(/\*\*([^*]+)\*\*/g)].map((x) => x[1]);
    assert.ok(bolds.length >= 4, 'Honest SLA must quote measured numbers');
    for (const b of bolds) {
      const v = /^(\d+(?:\.\d+)?)(x|%)/.exec(b.trim())?.[1];
      assert.ok(v, `unparseable ratio token: **${b}**`);
      assert.ok(measured.has(v), `**${b}** matches no bench in measured.json`);
    }
  });
});
