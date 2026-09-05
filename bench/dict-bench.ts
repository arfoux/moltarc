// bench/dict-bench — dictionary on/off delta on the repetitive corpus.
// Seals the same text twice (trained dict vs plain) and reports the saving.
// Usage: bun bench/dict-bench.ts [--rows 6000] [--seed 7] [--out bench/dict-out] [--write-readme]
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateMixedCorpus, measureArchive, recordMeasured } from './mixed-corpus.js';
import type { ArchiveMeasure } from './mixed-corpus.js';

export interface DictDelta {
  plain: ArchiveMeasure;
  withDict: ArchiveMeasure;
  savedBytes: number;
  savedPct: number;
}

export async function measureDictDelta(dir: string, rows: number, seed: number, targetBytes = 16 * 1024): Promise<DictDelta> {
  // Small target => several chunks: each chunk starts zstd cold, so the shared
  // trained dict is where it can actually help.
  const corpus = generateMixedCorpus(dir, rows, seed);
  const plain = await measureArchive(corpus.textPath, join(dir, 'arch-plain'), { trainDict: false, targetBytes });
  const withDict = await measureArchive(corpus.textPath, join(dir, 'arch-dict'), { trainDict: true, targetBytes });
  const savedBytes = plain.warmBytes - withDict.warmBytes;
  return { plain, withDict, savedBytes, savedPct: (100 * savedBytes) / plain.warmBytes };
}

const DICT_START = '<!-- DICT-MEASURED-START -->';
const DICT_END = '<!-- DICT-MEASURED-END -->';

export function dictTable(d: DictDelta): string {
  const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`;
  return [
    `${DICT_START}`,
    '| repetitive text, dict off vs on | warm archive | ratio |',
    '|---|---|---|',
    `| plain (no trained dict) | ${kb(d.plain.warmBytes)} | **${d.plain.ratio.toFixed(1)}x** |`,
    `| with 32KB per-table dict | ${kb(d.withDict.warmBytes)} | **${d.withDict.ratio.toFixed(1)}x** |`,
    `| saving | ${kb(d.savedBytes)} (${d.savedPct.toFixed(1)}%) | — |`,
    '',
    '_Measured by `bun bench/dict-bench.ts --write-readme`; same corpus both sides, ' +
    'only the dictionary differs. Columnar delta/RLE/inline-dict already captures most ' +
    'repetition — the trained dict takes what is left._',
    `${DICT_END}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.split('=')[1];
    return fallback;
  };
  const rows = Number(get('rows', '12000'));
  const seed = Number(get('seed', '7'));
  const here = dirname(fileURLToPath(import.meta.url));
  const out = get('out', join(here, 'dict-out'));
  const d = await measureDictDelta(out, rows, seed);
  console.log(`dict: plain=${d.plain.warmBytes}B dict=${d.withDict.warmBytes}B saved=${d.savedBytes}B (${d.savedPct.toFixed(1)}%) chunks=${d.withDict.chunks}`);
  recordMeasured(here, 'dict', {
    corpus: 'repetitive tx text, same corpus both sides, dict off vs on', rows, seed,
    plainWarm: d.plain.warmBytes, plainRatio: d.plain.ratio.toFixed(1),
    dictWarm: d.withDict.warmBytes, dictRatio: d.withDict.ratio.toFixed(1),
    savedBytes: d.savedBytes, savedPct: d.savedPct.toFixed(1),
  });
  if (argv.includes('--write-readme')) {
    const readme = join(here, '..', 'README.md');
    const cur = readFileSync(readme, 'utf8');
    const table = dictTable(d);
    const pattern = new RegExp(`${DICT_START}[\\s\\S]*${DICT_END}`);
    const next = existsSync(readme) && pattern.test(cur)
      ? cur.replace(pattern, () => table)
      : `${cur}\n## Dict SLA\n\n${table}\n`;
    writeFileSync(readme, next);
    console.log('README dict table updated');
  }
}

const invoked = (process.argv[1] ?? '').replace(/\\/g, '/');
if (invoked.endsWith('bench/dict-bench.ts') || invoked.endsWith('bench/dict-bench.js')) await main();
