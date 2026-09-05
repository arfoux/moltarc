// moltarc cold gc — cold tar segments plus prune sweep with manifest rewrite.
// Warm chunks merge into cold/seg-*.tar (plain ustar, chunks already zstd).
// The manifest (chunks[] + cold[]) is the ref source: a tar member whose
// name is not in chunks[] is unreferenced. sweepCold repacks partial
// segments without dead members, deletes fully-dead segments, and rewrites
// the manifest atomically (dual copy). Dry-run is the default.
// Dict-carrying segments: a merged chunk with DICT_FLAG in its header decodes
// only with its trained dictionary, so mergeCold packs every referenced
// dicts/dict-<hex>.dict member into the same tar (and refuses when the dict
// file is missing instead of writing an undecodable segment). A header dictId
// without DICT_FLAG is an inline content hint (decodeChunk ignores it), never
// a file requirement. sweepCold treats carried dict members as live while any
// manifest chunk names their dictId, and drops them with the last chunk.
// Reserve policy: every write path below (merge tar + manifest, sweep repack
// tmp + manifest) calls checkReserve first and throws before any byte lands,
// so a full disk never leaves a torn tar or a half-rewritten manifest.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadManifest, saveManifestAtomic } from './manifest.js';
import { readRelayIndex } from './ship.js';
import { checkReserve } from './gc.js';
import { decodeHeader, DICT_FLAG } from './chunk.js';
import { dictFile, dictHex } from './dict.js';

export interface TarMember {
  name: string;
  data: Buffer;
}

function checksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    if (i >= 148 && i < 156) sum += 32; // checksum field counts as spaces
    else sum += header[i];
  }
  return sum;
}

function tarHeader(name: string, size: number): Buffer {
  if (Buffer.byteLength(name, 'utf8') > 100) throw new Error(`tar name too long: ${name}`);
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write('0000777\0', 100, 'ascii'); // mode
  h.write('0000000\0', 108, 'ascii'); // uid
  h.write('0000000\0', 116, 'ascii'); // gid
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  h.write((0).toString(8).padStart(11, '0') + '\0', 136, 'ascii'); // mtime
  h.write('        ', 148, 'ascii'); // checksum placeholder
  h[156] = 48; // typeflag '0'
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write(checksum(h).toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

export function writeTar(members: TarMember[]): Buffer {
  const parts: Buffer[] = [];
  for (const m of members) {
    parts.push(tarHeader(m.name, m.data.length));
    parts.push(m.data);
    const pad = (512 - (m.data.length % 512)) % 512;
    if (pad > 0) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // two zero blocks = end of archive
  return Buffer.concat(parts);
}

export function readTar(buf: Buffer): TarMember[] {
  const out: TarMember[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break; // end marker
    const end = h.indexOf(0);
    const name = h.subarray(0, end < 0 ? 100 : end).toString('utf8');
    const sizeField = h.subarray(124, 136).toString('ascii').replace(/\0| /g, '');
    const size = sizeField === '' ? 0 : parseInt(sizeField, 8);
    if (!name || !Number.isFinite(size) || size < 0) throw new Error(`bad tar header at offset ${off}`);
    const start = off + 512;
    const data = Buffer.from(buf.subarray(start, start + size));
    if (data.length < size) throw new Error(`truncated tar member ${name}`);
    out.push({ name, data });
    off = start + size + ((512 - (size % 512)) % 512);
  }
  return out;
}

function segIndex(name: string): number {
  const m = /^seg-(\d+)\.tar$/.exec(name);
  return m ? Number(m[1]) : -1;
}

export interface MergeOpts {
  freeSpaceBytes?: number; // test seam: overrides statfs free-space reading
}

export interface MergeResult {
  segment: string;
  chunks: string[];
  dicts: string[]; // carried dict tar members (dicts/dict-<hex>.dict)
  bytes: number;
}

export function mergeCold(outDir: string, opts: MergeOpts = {}): MergeResult {
  const warm = join(outDir, 'warm');
  const cold = join(outDir, 'cold');
  mkdirSync(cold, { recursive: true });
  const { manifest } = loadManifest(outDir);
  manifest.cold ??= [];
  const packed = new Set(manifest.cold.flatMap((s) => s.chunks));
  const pending: TarMember[] = [];
  const wantDicts = new Set<number>();
  for (const e of manifest.chunks) {
    if (packed.has(e.file)) continue;
    const full = join(warm, e.file);
    if (!existsSync(full)) continue; // missing warm file: skip, never fail merge
    const data = readFileSync(full);
    pending.push({ name: e.file, data });
    // Dict need is flag-gated: header.dictId without DICT_FLAG is an inline
    // content hint, not a trained dict file (decodeChunk ignores it). Only
    // DICT_FLAG chunks name a dicts/dict-<hex>.dict member.
    let need = 0;
    try {
      const header = decodeHeader(data);
      if ((header.flags & DICT_FLAG) !== 0) need = header.dictId >>> 0;
    } catch {
      if (e.dictId !== 0) need = e.dictId >>> 0; // torn header: fail closed
    }
    if (need !== 0) wantDicts.add(need);
  }
  if (pending.length === 0) return { segment: '', chunks: [], dicts: [], bytes: 0 };
  // A dict-flagged chunk without its dictionary is undecodable: refuse the
  // whole merge instead of writing a segment that can never be read back.
  const dictDir = join(outDir, 'dicts');
  const dictMembers: TarMember[] = [];
  for (const dictId of [...wantDicts].sort((a, b) => a - b)) {
    const full = dictFile(dictDir, dictId);
    if (!existsSync(full)) {
      throw new Error(`merge refused: chunk(s) need dict-${dictHex(dictId)}.dict, file missing (reseal to retrain)`);
    }
    dictMembers.push({ name: `dicts/dict-${dictHex(dictId)}.dict`, data: readFileSync(full) });
  }
  pending.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const members = [...pending, ...dictMembers];
  const existing = existsSync(cold) ? readdirSync(cold).map(segIndex).filter((n) => n >= 0) : [];
  const next = existing.length === 0 ? 1 : Math.max(...existing) + 1;
  const segment = `seg-${String(next).padStart(6, '0')}.tar`;
  const tar = writeTar(members);
  // Reserve first: fail-closed before the tar tmp or the manifest moves.
  checkReserve(outDir, opts.freeSpaceBytes, 'merge');
  const dest = join(cold, segment);
  const tmp = `${dest}.tmp.${process.pid}`;
  writeFileSync(tmp, tar);
  renameSync(tmp, dest);
  manifest.cold.push({ file: segment, chunks: pending.map((m) => m.name), bytes: tar.length });
  saveManifestAtomic(outDir, manifest);
  return { segment, chunks: pending.map((m) => m.name), dicts: dictMembers.map((m) => m.name), bytes: tar.length };
}

// Retention prune: drop manifest entries by chunk file name, atomic dual copy.
// Tar bytes stay on disk until sweepCold repacks without them.
// Relay-ack guard: every target must be acked in the relay index (written
// by ship). Forgetting the only unshipped chunk would make its warm bytes
// an orphan that gc deletes, so unacked targets throw instead of pruning
// silently. The check is atomic: all-or-nothing, no partial forget.
export function forgetChunks(outDir: string, files: string[], relayDir: string): { removed: string[] } {
  if (!relayDir) throw new Error('forget needs the relayDir ship wrote to (refusing silent unacked delete)');
  const { manifest } = loadManifest(outDir);
  const drop = new Set(files);
  const targets = manifest.chunks.filter((e) => drop.has(e.file));
  const remote = readRelayIndex(relayDir);
  const have = new Set(Object.keys(remote.chunks));
  const unacked = targets.filter((e) => !have.has(e.sha256)).map((e) => e.file);
  if (unacked.length > 0) {
    throw new Error(`refusing to forget unacked chunk(s): ${unacked.join(', ')} (ship first)`);
  }
  const removed = targets.map((e) => e.file);
  manifest.chunks = manifest.chunks.filter((e) => !drop.has(e.file));
  saveManifestAtomic(outDir, manifest);
  return { removed };
}

export interface ColdSweepOpts {
  dryRun?: boolean; // default true
  freeSpaceBytes?: number; // test seam: overrides statfs free-space reading
}

export interface RepackedSeg {
  file: string;
  before: number;
  after: number;
}

export interface ColdSweepResult {
  segments: string[];
  pruned: string[];
  repacked: RepackedSeg[];
  bytesBefore: number;
  bytesAfter: number;
  bytesReclaimed: number;
  dryRun: boolean;
}

export function sweepCold(outDir: string, opts: ColdSweepOpts = {}): ColdSweepResult {
  const dryRun = opts.dryRun ?? true;
  const cold = join(outDir, 'cold');
  mkdirSync(cold, { recursive: true });
  // Reserve first when writes may follow: fail-closed before any repack tmp
  // or manifest rewrite lands. Read-only dry-runs never touch the disk.
  if (!dryRun) checkReserve(outDir, opts.freeSpaceBytes, 'cold sweep');
  const { manifest } = loadManifest(outDir);
  manifest.cold ??= [];
  const refs = new Set(manifest.chunks.map((e) => e.file));
  // Carried dicts stay live while any manifest chunk names their dictId.
  const liveDicts = new Set(
    manifest.chunks.filter((e) => e.dictId !== 0).map((e) => `dicts/dict-${dictHex(e.dictId >>> 0)}.dict`),
  );
  const bySeg = new Map(manifest.cold.map((s) => [s.file, s]));
  const segments = readdirSync(cold).filter((f) => segIndex(f) >= 0).sort();
  const pruned: string[] = [];
  const repacked: RepackedSeg[] = [];
  let bytesBefore = 0;
  let bytesAfter = 0;
  for (const file of segments) {
    let raw: Buffer;
    try {
      raw = readFileSync(join(cold, file));
    } catch {
      continue; // raced delete: ignore
    }
    bytesBefore += raw.length;
    const entry = bySeg.get(file);
    const known = entry ? new Set(entry.chunks) : null;
    let members: TarMember[];
    try {
      members = readTar(raw);
    } catch {
      continue; // corrupt segment: quarantine by leaving it, never delete blind
    }
    const live = members.filter((m) => (m.name.startsWith('dicts/') ? liveDicts.has(m.name) : refs.has(m.name) && (known === null || known.has(m.name))));
    const liveNames = new Set(live.filter((m) => !m.name.startsWith('dicts/')).map((m) => m.name));
    const dead = members.length - live.length;
    if (dead === 0) {
      bytesAfter += raw.length;
      continue;
    }
    if (live.length === 0) {
      // Fully unreferenced: drop the whole segment.
      pruned.push(file);
      if (!dryRun) {
        try { unlinkSync(join(cold, file)); } catch { /* raced delete */ }
        manifest.cold = manifest.cold.filter((s) => s.file !== file);
      }
      continue;
    }
    // Partially referenced: repack without dead members.
    live.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const next = writeTar(live);
    repacked.push({ file, before: raw.length, after: next.length });
    bytesAfter += next.length;
    if (!dryRun) {
      const dest = join(cold, file);
      const tmp = `${dest}.tmp.${process.pid}`;
      writeFileSync(tmp, next);
      renameSync(tmp, dest);
      const seg = manifest.cold.find((s) => s.file === file);
      if (seg) {
        seg.chunks = [...liveNames].sort();
        seg.bytes = next.length;
      }
    }
  }
  const bytesReclaimed = bytesBefore - bytesAfter;
  if (!dryRun && (pruned.length > 0 || repacked.length > 0)) {
    saveManifestAtomic(outDir, manifest);
  }
  return { segments, pruned, repacked, bytesBefore, bytesAfter, bytesReclaimed, dryRun };
}

export function coldDiskBytes(outDir: string): { segments: number; chunks: number; bytes: number } {
  const cold = join(outDir, 'cold');
  if (!existsSync(cold)) return { segments: 0, chunks: 0, bytes: 0 };
  let segments = 0;
  let chunks = 0;
  let bytes = 0;
  for (const f of readdirSync(cold).filter((x) => segIndex(x) >= 0).sort()) {
    try {
      const raw = readFileSync(join(cold, f));
      segments++;
      bytes += raw.length;
      try { chunks += readTar(raw).length; } catch { /* corrupt: count bytes only */ }
    } catch { /* raced delete */ }
  }
  return { segments, chunks, bytes };
}
