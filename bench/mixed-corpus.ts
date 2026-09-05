// bench/mixed-corpus — deterministic mixed corpus + measured archive ratios.
// Split: 60% repetitive tx text, 25% free-form notes, 15% blob hash-refs whose
// bytes live in a sidecar and NEVER enter the mandatory archive.
// Usage: bun bench/mixed-corpus.ts [--rows 6000] [--seed 7] [--out bench/out] [--write-readme]
import { mkdirSync, readFileSync, statSync, readdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, createHash } from 'crypto';
import { seal } from '../src/seal.js';

export const CORPUS_SPEC = '60% repetitive tx / 25% free notes / 15% blob refs (bytes excluded)';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CASHIERS = ['agus', 'budi', 'citra', 'dewa', 'eka', 'fitri', 'galih', 'hani'];
const STORES = ['jakarta-selatan', 'bogor-kota', 'depok-timur', 'bekasi-utara'];
const METHODS = ['cash', 'qris', 'transfer'];
const SKUS = ['INDOMIE-GORENG', 'BERAS-5KG', 'GULA-1KG', 'KOPI-KAPAL', 'TEH-BOTOL', 'SUSU-UHT',
  'MINYAK-2L', 'TELUR-1KG', 'ROTI-TAWAR', 'SABUN-MANDI', 'SHAMPOO', 'DETERJEN',
  'SAOS-TOMAT', 'KECAP-MANIS', 'MIE-SEDAP', 'BISKUIT', 'PERMEN', 'AIR-19L',
  'GAS-3KG', 'PULSA-10K', 'TOKEN-50K', 'ES-BATU', 'TISU', 'MASKER',
  'VITAMIN-C', 'OBAT-NYAMUK', 'LAMPU-LED', 'BATERAI-AA', 'PAYUNG', 'SANDAL'];
const WORDS = ('pagi ini stok gudang menipis kirim segera tolong catat manual nota hilang ' +
  'pelanggan komplain harga selisih kasir lupa tutup shift kemarin lampu mati sebentar ' +
  'kulkas bunyi aneh teknisi datang siang antar barang telat macet hujan deras banjir ' +
  'parkir penuh satpam bantu atur anak magang baru dilatih rajin sekali pelanggan tetap ' +
  'minta diskon tambaharmi supir ekspedisi rokok sambil tunggu bongkar cepat dibantu ' +
  'kucing tidur rak mie difoto pembeli becanda kasir sabar antre panjang sabtu rame ' +
  'minggu sepi senin sibuk selasa santai rabu rapat kamis lembur jumat berkah tolong ' +
  'cek ulang selisih seribu rupiah dompet tertinggal ambil besok kunci gembok ganti ' +
  'baru semalam maling gagal masuk alarm bunyi cat dinding luntur bocor atap ember ' +
  'tampung tetesan tikus makan sabun pasang perangkap lagi cicak jatuh etalase kaget ' +
  'pembeli tertawa daftar belanja ibu itu panjang banget antre kasir dua buka semua ' +
  'mesin edc error gesek tiga kali baru bisa struk kertas habis ganti rol dulu tinta ' +
  'printer pudar bersihkan head semprot angin kalibrasi timbangan geser nol atur ulang ' +
  'es krim meleleh freezer pintu tidak rapat tutup rapat ingatkan tutup kembali telur ' +
  'pecah satu rak bersihkan segera amis lap kain pel bau apek jemur dulu sapu lidi ' +
  'patah beli baru iuran beli galon patungan parkir langganan tukang sayur lewat depan ' +
  'titip kangkung bayam segar ikan asin bau menyengat pindah belakang durian musim ' +
  'tumpuk depan aroma kuat pembeli protes pindah gudang saja').split(' ');

function pick<T>(rnd: () => number, arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}

const NAMES = ['warto', 'siti', 'slamet', 'rini', 'joko', 'sari', 'bambang', 'dewi', 'agus', 'ratna', 'yanto', 'lina', 'dedi', 'maya', 'tono', 'putri', 'andi', 'nina', 'rudi', 'wulan', 'asep', 'euis', 'dadang', 'eneng'];

function noteBody(rnd: () => number): string {
  const n = 35 + Math.floor(rnd() * 20);
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(pick(rnd, WORDS));
  const digits = (k: number) => Array.from({ length: k }, () => Math.floor(rnd() * 10)).join('');
  return `NOTE ${words.join(' ')} pic=${pick(rnd, NAMES)} nota=${digits(6)} telp=08${digits(10)}`;
}

const HEAD = 'TOKO SUMBER MAKMUR JL RAYA BOGOR KM 42 TELP 0251-000000 NPWP 00.000.000.0-000.000 BUKA 07.00-22.00 WIB KEMITRAAN WARUNG NAIK KELAS SE-JAWA BARAT STRUK:';

const TAIL = 'TERIMA KASIH SUDAH BERBELANJA BARANG YANG SUDAH DIBELI TIDAK DAPAT DIKEMBALIKAN PROMO TUKAR STRUK DENGAN KUPON UNDIAN BERHADIAH PERIODE JAN-DES 2026';

function txBody(rnd: () => number): string {
  const c = pick(rnd, CASHIERS);
  const s = pick(rnd, STORES);
  const m = pick(rnd, METHODS);
  const kind = rnd();
  let core: string;
  if (kind < 0.45) {
    const amt = 5000 + Math.floor(rnd() * 20) * 10000;
    const change = m === 'cash' ? Math.floor(rnd() * 8) * 1000 : 0;
    core = `TRANSACTION OK amount=${amt} cashier=${c} tend=${m} change=${change} store=${s}`;
  } else if (kind < 0.7) {
    core = `STOCK UPDATE sku=${pick(rnd, SKUS)} qty=${1 + Math.floor(rnd() * 25) * 4} shelf=${pick(rnd, ['A1', 'A2', 'A3', 'B1', 'B2', 'C1'])} store=${s}`;
  } else if (kind < 0.85) {
    core = `SHIFT ${rnd() < 0.5 ? 'OPEN' : 'CLOSE'} cashier=${c} float=${100 + Math.floor(rnd() * 9) * 50000} drawer=${1 + Math.floor(rnd() * 3)} store=${s}`;
  } else {
    core = `PAYMENT SETTLED method=${m} batches=${1 + Math.floor(rnd() * 5)} fee=${500 + Math.floor(rnd() * 10) * 100} store=${s}`;
  }
  return `${HEAD} ${core} ${TAIL}`;
}
export interface CorpusPaths {
  textPath: string;
  mixedPath: string;
  blobSidecar: string;
  blobBytes: number;
  textInputBytes: number;
  mixedInputBytes: number;
}

export function generateMixedCorpus(dir: string, rows: number, seed: number): CorpusPaths {
  mkdirSync(dir, { recursive: true });
  const rnd = mulberry32(seed);
  const base = 1_700_000_000_000;
  const textLines: string[] = [];
  const mixedLines: string[] = [];
  const blobParts: Buffer[] = [];
  for (let i = 0; i < rows; i++) {
    const seq = i + 1;
    const id = `trx-${String(seq).padStart(8, '0')}`;
    const slot = rnd();
    if (slot < 0.6) {
      const line = JSON.stringify({ device_id: 'pos-01', seq, ts: base + i * 1000, id, table: 'sales', body: txBody(rnd) });
      textLines.push(line);
      mixedLines.push(line);
    } else if (slot < 0.85) {
      const line = JSON.stringify({ device_id: 'pos-01', seq, ts: base + i * 1000, id, table: 'notes', body: noteBody(rnd) });
      mixedLines.push(line);
    } else {
      // Incompressible bytes stay out of the archive; only the hash ref ships.
      const bytes = randomBytes(4096);
      const h = createHash('sha256').update(bytes).digest('hex');
      blobParts.push(bytes);
      mixedLines.push(JSON.stringify({ device_id: 'cam-01', seq, ts: base + i * 1000, id, table: 'photo', body: `blob:sha256:${h}:size=4096` }));
    }
  }
  const textPath = join(dir, 'hot-text.jsonl');
  const mixedPath = join(dir, 'hot-mixed.jsonl');
  const blobSidecar = join(dir, 'blobs.bin');
  writeFileSync(textPath, `${textLines.join('\n')}\n`);
  writeFileSync(mixedPath, `${mixedLines.join('\n')}\n`);
  writeFileSync(blobSidecar, Buffer.concat(blobParts));
  return {
    textPath, mixedPath, blobSidecar,
    blobBytes: blobParts.reduce((n, b) => n + b.length, 0),
    textInputBytes: Buffer.byteLength(textLines.join('\n')),
    mixedInputBytes: Buffer.byteLength(mixedLines.join('\n')),
  };
}


export interface ArchiveMeasure {
  inputBytes: number;
  warmBytes: number;
  ratio: number;
  chunks: number;
}

export async function measureArchive(hotPath: string, outDir: string, sealOpts?: { trainDict?: boolean; targetBytes?: number }): Promise<ArchiveMeasure> {
  rmSync(outDir, { recursive: true, force: true });
  const inputBytes = statSync(hotPath).size;
  const r = await seal({ hotDb: hotPath, outDir, ...sealOpts });
  const warm = join(outDir, 'warm');
  const warmBytes = readdirSync(warm).filter((f: string) => f.endsWith('.chk')).reduce((n: number, f: string) => n + statSync(join(warm, f)).size, 0);
  return { inputBytes, warmBytes, ratio: inputBytes / warmBytes, chunks: r.chunks.length };
}

const README_START = '<!-- SLA-MEASURED-START -->';
const README_END = '<!-- SLA-MEASURED-END -->';

export function slaTable(text: ArchiveMeasure, mixed: ArchiveMeasure, blobBytes: number): string {
  const mb = (n: number) => `${(n / 1048576).toFixed(2)}MB`;
  const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`;
  return [
    `${README_START}`,
    '| corpus | input | warm archive | ratio |',
    '|---|---|---|---|',
    `| repetitive tx text (${CORPUS_SPEC.split(' / ')[0]}) | ${mb(text.inputBytes)} | ${kb(text.warmBytes)} | **${text.ratio.toFixed(1)}x** |`,
    `| mixed text+notes+refs (blob bytes excluded) | ${mb(mixed.inputBytes)} | ${kb(mixed.warmBytes)} | **${mixed.ratio.toFixed(1)}x** |`,
    `| photo blobs (${mb(blobBytes)} sidecar, lazy/on-demand) | excluded | excluded | n/a (incompressible) |`,
    '',
    '_Measured by `bun bench/mixed-corpus.ts --write-readme`; corpus deterministic (seeded). ' +
    'Blob bytes never enter the mandatory archive — only `blob:sha256:…` refs do._',
    `${README_END}`,
  ].join('\n');
}

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([^=]+)(=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    if (m[3] !== undefined) out[m[1]] = m[3];
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[m[1]] = argv[++i];
    else out[m[1]] = '1';
  }
  return out;
}

async function main(): Promise<void> {
  const a = args();
  const rows = Number(a.rows ?? '6000');
  const seed = Number(a.seed ?? '7');
  const here = dirname(fileURLToPath(import.meta.url));
  const out = a.out ?? join(here, 'out');
  const corpus = generateMixedCorpus(out, rows, seed);
  const text = await measureArchive(corpus.textPath, join(out, 'arch-text'));
  const mixed = await measureArchive(corpus.mixedPath, join(out, 'arch-mixed'));
  console.log(`corpus: ${CORPUS_SPEC} rows=${rows} seed=${seed}`);
  console.log(`text : input=${text.inputBytes}B warm=${text.warmBytes}B ratio=${text.ratio.toFixed(1)}x chunks=${text.chunks}`);
  console.log(`mixed: input=${mixed.inputBytes}B warm=${mixed.warmBytes}B ratio=${mixed.ratio.toFixed(1)}x chunks=${mixed.chunks}`);
  console.log(`blobs: sidecar=${corpus.blobBytes}B excluded from mandatory archive`);
  if (a['write-readme']) {
    const root = join(here, '..');
    const readme = join(root, 'README.md');
    const cur = readFileSync(readme, 'utf8');
    const table = slaTable(text, mixed, corpus.blobBytes);
    const pattern = new RegExp(`${README_START}[\\s\\S]*${README_END}`);
    const next = existsSync(readme) && pattern.test(cur)
      ? cur.replace(pattern, () => table)
      : `${cur}\n## Measured SLA\n\n${table}\n`;
    writeFileSync(readme, next);
    console.log('README SLA table updated');
  }
}

const invokedAsScript = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('bench/mixed-corpus.ts')
  || (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('bench/mixed-corpus.js');
if (invokedAsScript) await main();
