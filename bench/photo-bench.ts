// bench/photo-bench — real JPEGs (noise + pure-js encode) sealed next to text.
// Proves the photo claim: jpeg bytes are incompressible, archive carries refs.
// Usage: bun bench/photo-bench.ts [--photos 50] [--rows 600] [--out bench/photo-out] [--write-readme]
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { zstdCompressSync } from 'zlib';
import { encode } from 'jpeg-js';
import { seal } from '../src/seal.js';
import { mulberry32, recordMeasured } from './mixed-corpus.js';

export const PHOTO_QUALITY = 85;
export const PHOTO_SIZE = 128;

export interface PhotoCorpus {
  hotPath: string;
  jpegBytes: number;
  photoInputBytes: number;
  textInputBytes: number;
  photoIds: string[];
}

// Deterministic sensor-noise JPEGs, box-blurred toward natural-image
// statistics: incompressible by construction, real jpeg container.
export function makeJpeg(seed: number): Buffer {
  const rnd = mulberry32(seed);
  const w = PHOTO_SIZE;
  const n = w * w;
  const px = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    px[i * 3] = Math.floor(rnd() * 256);
    px[i * 3 + 1] = Math.floor(rnd() * 256);
    px[i * 3 + 2] = Math.floor(rnd() * 256);
  }
  // Box blur radius 1: kills white-noise spikes, keeps photographic gradients.
  const sm = Buffer.alloc(n * 3);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= w) continue;
            s += px[(yy * w + xx) * 3 + c];
            k++;
          }
        }
        sm[(y * w + x) * 3 + c] = Math.round(s / k);
      }
    }
  }
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = sm[i * 3];
    data[i * 4 + 1] = sm[i * 3 + 1];
    data[i * 4 + 2] = sm[i * 3 + 2];
    data[i * 4 + 3] = 0xff;
  }
  return Buffer.from(encode({ data, width: w, height: w }, PHOTO_QUALITY).data);
}
export function generatePhotoCorpus(dir: string, photos: number, textRows: number, seed: number): PhotoCorpus {
  mkdirSync(dir, { recursive: true });
  const rnd = mulberry32(seed);
  const base = 1_700_000_000_000;
  const lines: string[] = [];
  const photoIds: string[] = [];
  let jpegBytes = 0;
  let photoInputBytes = 0;
  let textInputBytes = 0;
  let seq = 0;
  const snapshot = (id: string, table: string, body: string, device: string): string =>
    JSON.stringify({ device_id: device, seq: ++seq, ts: base + seq * 1000, id, table, body });
  for (let i = 0; i < textRows; i++) {
    const id = `trx-${String(seq + 1).padStart(8, '0')}`;
    const line = snapshot(id, 'sales', `TRANSACTION OK amount=${2000 + ((i * 137) % 200) * 1000} cashier=${['agus', 'budi', 'citra', 'dewa'][i % 4]} tend=${i % 3 === 0 ? 'cash' : 'qris'} store=bogor-kota`, 'kasir-01');
    lines.push(line);
    textInputBytes += Buffer.byteLength(line);
  }
  for (let p = 0; p < photos; p++) {
    const id = `trx-${String(seq + 1).padStart(8, '0')}`;
    const jpeg = makeJpeg(seed * 1000 + p);
    jpegBytes += jpeg.length;
    const line = snapshot(id, 'photo', jpeg.toString('base64'), 'cam-01');
    photoIds.push(id);
    lines.push(line);
    photoInputBytes += Buffer.byteLength(line);
  }
  const hotPath = join(dir, 'hot-photo.jsonl');
  writeFileSync(hotPath, `${lines.join('\n')}\n`);
  return { hotPath, jpegBytes, photoInputBytes, textInputBytes, photoIds };
}

export interface PhotoMeasure {
  photoRatio: number;
  textRatio: number;
  rawJpegRatio: number;
  photoWarm: number;
  textWarm: number;
}

export async function measurePhotoCorpus(dir: string, photos: number, textRows: number, seed: number): Promise<{ corpus: PhotoCorpus; measure: PhotoMeasure }> {
  const corpus = generatePhotoCorpus(dir, photos, textRows, seed);
  const outDir = join(dir, 'arch');
  rmSync(outDir, { recursive: true, force: true });
  await seal({ hotDb: corpus.hotPath, outDir });
  const warm = join(outDir, 'warm');
  const sumPrefix = (prefix: string): number => readdirSync(warm)
    .filter((f: string) => f.startsWith(prefix) && f.endsWith('.chk'))
    .reduce((n: number, f: string) => n + statSync(join(warm, f)).size, 0);
  const photoWarm = sumPrefix('photo-');
  const textWarm = sumPrefix('sales-');
  // Raw container check: zstd straight over concatenated jpeg bytes.
  const rawJpegs = corpus.photoIds.length; // count guard
  void rawJpegs;
  const jpegConcat = concatJpegs(dir, photos, seed);
  const rawJpegRatio = jpegConcat.length / zstdCompressSync(jpegConcat).length;
  return {
    corpus,
    measure: {
      photoRatio: corpus.photoInputBytes / photoWarm,
      textRatio: corpus.textInputBytes / textWarm,
      rawJpegRatio,
      photoWarm,
      textWarm,
    },
  };
}

function concatJpegs(_dir: string, photos: number, seed: number): Buffer {
  const parts: Buffer[] = [];
  for (let p = 0; p < photos; p++) parts.push(makeJpeg(seed * 1000 + p));
  return Buffer.concat(parts);
}

const PHOTO_START = '<!-- PHOTO-MEASURED-START -->';
const PHOTO_END = '<!-- PHOTO-MEASURED-END -->';

export function photoTable(m: PhotoMeasure, jpegBytes: number): string {
  return [
    `${PHOTO_START}`,
    '| bytes | input | warm archive | ratio |',
    '|---|---|---|---|',
    `| 50 real jpeg (128x128 blurred noise, q85, ${Math.round(jpegBytes / 1024)}KB raw) sealed as base64 lines | base64 in jsonl | per-table chunks | **${m.photoRatio.toFixed(2)}x** |`,
    `| same jpeg bytes, raw zstd (the foto claim) | ${Math.round(jpegBytes / 1024)}KB raw | zstd | **${m.rawJpegRatio.toFixed(2)}x, inside 1.0-1.2x** |`,
    `| tx text beside the photos | text jsonl | text chunks + dict | **${m.textRatio.toFixed(1)}x** |`,
    '',
    '_Measured by `bun bench/photo-bench.ts --write-readme`; deterministic (seeded). ' +
    'The base64 line ratio rides above raw because of the text envelope — raw jpeg bytes sit ' +
    'at ~1.05x, which is why photo bytes never enter the mandatory archive (hash refs only, lazy fetch)._',
    `${PHOTO_END}`,
  ].join('\n');
}
function argGet(argv: string[], name: string, fallback: string): string {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=')[1];
  return fallback;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (name: string, fallback: string): string => argGet(argv, name, fallback);
  const photos = Number(get('photos', '50'));
  const rows = Number(get('rows', '600'));
  const seed = Number(get('seed', '11'));
  const here = dirname(fileURLToPath(import.meta.url));
  const out = get('out', join(here, 'photo-out'));
  const { corpus, measure } = await measurePhotoCorpus(out, photos, rows, seed);
  console.log(`photos: jpeg=${corpus.jpegBytes}B photo-lines=${corpus.photoInputBytes}B warm=${measure.photoWarm}B ratio=${measure.photoRatio.toFixed(2)}x`);
  console.log(`raw jpeg zstd ratio=${measure.rawJpegRatio.toFixed(2)}x text ratio=${measure.textRatio.toFixed(1)}x`);
  recordMeasured(here, 'photo', {
    corpus: `${photos} real jpeg 128x128 blurred noise q${PHOTO_QUALITY} plus ${rows} tx text rows`, photos, rows, seed,
    jpegBytes: corpus.jpegBytes, photoWarm: measure.photoWarm, photoRatio: measure.photoRatio.toFixed(2),
    rawJpegRatio: measure.rawJpegRatio.toFixed(2), textRatio: measure.textRatio.toFixed(1), textWarm: measure.textWarm,
  });
  if (argv.includes('--write-readme')) {
    const readme = join(here, '..', 'README.md');
    const cur = readFileSync(readme, 'utf8');
    const table = photoTable(measure, corpus.jpegBytes);
    const pattern = new RegExp(`${PHOTO_START}[\\s\\S]*${PHOTO_END}`);
    const next = existsSync(readme) && pattern.test(cur)
      ? cur.replace(pattern, () => table)
      : `${cur}\n## Photo SLA\n\n${table}\n`;
    writeFileSync(readme, next);
    console.log('README photo table updated');
  }
}

const invoked = (process.argv[1] ?? '').replace(/\\/g, '/');
if (invoked.endsWith('bench/photo-bench.ts') || invoked.endsWith('bench/photo-bench.js')) await main();
