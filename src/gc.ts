// moltarc gc — orphan sweep + status meter + reserve-space guard.
// Orphan = warm/*.chk file with refcount 0 in the manifest (not referenced
// by any manifest entry). Sweep defaults to dry-run: lists orphans, deletes
// nothing unless dryRun:false is passed explicitly.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, statfsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { loadManifest } from './manifest.js';
import { requireMigrated } from './migrate.js';
import { readRelayIndex } from './ship.js';
import { HEADER_SIZE, decodeChunk, decodeHeader, sha256hex, DICT_FLAG } from './chunk.js';
import { dictHex, loadDictFor } from './dict.js';
// deleted under dryRun:false. Dicts carry no ack state: referenced or not.
// Reserve policy: sweep only deletes (no tar/manifest writes), so it never
// trips the 50MB reserve. Write paths (seal, mergeCold, sweepCold --apply)
// call checkReserve first and throw before any half-write; see cold.ts.

// Seal refuses below this much free space so it never half-writes a chunk,
// watermark, or manifest copy.
export const RESERVE_BYTES = 50 * 1024 * 1024;

export function freeSpaceBytes(dir: string): number {
  try {
    const st = statfsSync(dir);
    return Number(st.bfree) * Number(st.bsize);
  } catch {
    // statfs unavailable (or dir missing): assume space, seal proceeds.
    return Number.MAX_SAFE_INTEGER;
  }
}

export function checkReserve(dir: string, free?: number, op = 'seal'): void {
  const target = existsSync(dir) ? dir : join(dir, '..');
  const avail = free ?? freeSpaceBytes(target);
  if (avail < RESERVE_BYTES) {
    throw new Error(
      `${op} refused: only ${avail} bytes free, need 50MB reserve (free up space and retry)`,
    );
  }
}

export interface SweepOpts {
  dryRun?: boolean; // default true
  relayDir?: string; // REQUIRED when dryRun:false (gc --apply): gc only deletes relay-acked chunks (rule 7); dry-run without it retains all orphans, apply without it throws
  deepPhoto?: boolean; // default false: scan warm chunks for photo refs, sweep unreferenced photo/*.bin
  freeSpaceBytes?: number; // reserved for future write paths; sweep deletes only, never checks
}

export interface SweepResult {
  orphans: string[];
  removed: string[];
  skippedUnacked: string[]; // orphans retained: bytes not acked by the relay (or relay unknown)
  dictOrphans: string[]; // dict files unreferenced by any live manifest entry
  dictsRemoved: string[]; // orphan dicts deleted (dryRun:false only)
  dictBytesReclaimed: number;
  photoOrphans: string[]; // photo/<sha>.bin + thumb companions unreferenced by any warm chunk (deepPhoto only)
  photoRemoved: string[]; // orphan photo files deleted (dryRun:false + relay ack; apply without relayDir throws)
  photoMissing: { ref: string; chunk: string }[]; // referenced shas with no sidecar file (deepPhoto only)
  litter: string[]; // tmp/state litter found (relative sub/file), reported even on dry-run
  litterRemoved: string[]; // litter deleted (dryRun:false only)
  bytesReclaimed: number;
  dryRun: boolean;
  chunks: number;
  bytes: number;
}

const PHOTO_SHA_RE = /^photo:sha256:([0-9a-f]{64}):size=\d+$/;

// Relay photo ack map (Wave2 relay/photo/<sha>.bin layout): returns null when
// the index has no `photo` key or is unreadable — absent map retains all,
// never throws. Shape stays tolerant: keys are full shas, values filenames.
function readRelayPhotoMap(relayDir: string): Record<string, string> | null {
  try {
    const raw = JSON.parse(readFileSync(join(relayDir, 'index.json'), 'utf8')) as { photo?: unknown };
    if (!raw || typeof raw !== 'object' || !('photo' in raw)) return null;
    const m = raw.photo;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    return m as Record<string, string>;
  } catch {
    return null;
  }
}

export function sweep(outDir: string, opts: SweepOpts = {}): SweepResult {
  const dryRun = opts.dryRun ?? true;
  if (!dryRun && !opts.relayDir) throw new Error('gc --apply requires relayDir: gc only deletes relay-acked chunks (rule 7)');
  // Downgrade guard on mutating runs only: dry-run is read-only and must
  // keep reporting on old archives; apply refuses to touch them.
  if (!dryRun) requireMigrated(outDir);
  const warm = join(outDir, 'warm');
  mkdirSync(warm, { recursive: true });
  const { manifest } = loadManifest(outDir);
  // Refcount over manifest entries; a disk file with 0 refs is an orphan.
  const refs = new Map<string, number>();
  for (const e of manifest.chunks) refs.set(e.file, (refs.get(e.file) ?? 0) + 1);
  // Relay-ack backstop for forget-before-ship states (older prunes, raced
  // deletes): an orphan whose content sha is not in the relay index is
  // unshipped working data, so it stays even under dryRun:false. Apply
  // without relayDir throws above (ack state unknowable: never delete
  // working data blind); with relayDir, unknown-ack orphans still retain.
  const acked = opts.relayDir ? new Set(Object.keys(readRelayIndex(opts.relayDir).chunks)) : null;
  let chunks = 0;
  let bytes = 0;
  const orphans: string[] = [];
  const skippedUnacked: string[] = [];
  let orphanBytes = 0;
  for (const f of readdirSync(warm).filter((f: string) => f.endsWith('.chk')).sort()) {
    try {
      const st = statSync(join(warm, f));
      chunks++;
      bytes += st.size;
      if ((refs.get(f) ?? 0) === 0) {
        orphans.push(f);
        orphanBytes += st.size;
        if (acked) {
          let sha = '';
          try { sha = sha256hex(readFileSync(join(warm, f))); } catch { /* raced delete: fall through */ }
          if (!acked.has(sha)) skippedUnacked.push(f);
        } else {
          skippedUnacked.push(f); // no relayDir: ack unknown, retain
        }
      }
    } catch { /* raced delete: ignore */ }
  }
  const skipped = new Set(skippedUnacked);
  const removed: string[] = [];
  let bytesReclaimed = 0;
  if (!dryRun) {
    for (const f of orphans) {
      if (skipped.has(f)) continue;
      try {
        const st = statSync(join(warm, f));
        unlinkSync(join(warm, f));
        removed.push(f);
        bytesReclaimed += st.size;
      } catch { /* raced delete: ignore */ }
    }
  } else {
    bytesReclaimed = orphanBytes - skippedUnacked.reduce((n, f) => {
      try { return n + statSync(join(warm, f)).size; } catch { return n; }
    }, 0);
  }
  // Orphan dicts: content-hashed and immutable, referenced by header dictId.
  // Liveness is the union of manifest refs AND on-disk headers in warm/ and
  // quarantine/: a kill mid-seal can leave a chunk on disk ahead of the
  // manifest, and a parked (quarantined) chunk can vanish from the manifest
  // on the next rescan while its bytes still await relay repair. Deleting
  // either chunk's dict first would make the later rescan anchor
  // undecodable rows. Dicts carry no ack state, so no relay check; but an
  // unsurveyable dir (torn header) proves nothing, so dict deletion skips
  // that run.
  const liveDicts = new Set(
    manifest.chunks.filter((e) => e.dictId !== 0).map((e) => `dict-${dictHex(e.dictId)}.dict`),
  );
  let surveyOk = true;
  for (const sub of ['warm', 'quarantine']) {
    if (!surveyOk) break;
    let names: string[] = [];
    try {
      names = readdirSync(join(outDir, sub)).filter((f: string) => f.endsWith('.chk')).sort();
    } catch { continue; } // dir absent: nothing parked here
    for (const f of names) {
      let fd = -1;
      try {
        fd = openSync(join(outDir, sub, f), 'r');
        const head = Buffer.alloc(HEADER_SIZE);
        if (readSync(fd, head, 0, HEADER_SIZE, 0) !== HEADER_SIZE) { surveyOk = false; break; }
        const header = decodeHeader(head);
        if (header.dictId !== 0) liveDicts.add(`dict-${dictHex(header.dictId)}.dict`);
      } catch { surveyOk = false; break; }
      finally {
        if (fd >= 0) try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  }
  const dictDir = join(outDir, 'dicts');
  const dictOrphans: string[] = [];
  const dictsRemoved: string[] = [];
  let dictBytesReclaimed = 0;
  let dictOrphanBytes = 0;
  if (surveyOk) {
    try {
      for (const f of readdirSync(dictDir).filter((f: string) => f.endsWith('.dict')).sort()) {
        if (liveDicts.has(f)) continue;
        dictOrphans.push(f);
        let size = 0;
        try { size = statSync(join(dictDir, f)).size; } catch { continue; }
        dictOrphanBytes += size;
        if (!dryRun) {
          try {
            unlinkSync(join(dictDir, f));
            dictsRemoved.push(f);
            dictBytesReclaimed += size;
          } catch { /* raced delete: ignore */ }
        }
      }
    } catch { /* no dicts dir yet: nothing orphaned */ }
    if (dryRun) dictBytesReclaimed = dictOrphanBytes;
  }
  // Deep photo sweep (opt-in via deepPhoto): warm chunk bodies carry
  // photo:sha256:<sha>:size=<n> hash refs whose bytes live beside the archive
  // in photo/<sha>.bin (+thumb-<sha>.jpg/json previews). A sidecar no warm
  // chunk references is dead weight: listed as photo/<file> in photoOrphans,
  // deleted on apply iff the relay acks the sha. Ack state comes from the
  // relay index `photo` map (Wave2 relay/photo/<sha>.bin layout); a relay
  // index with no `photo` key proves nothing, so apply retains everything
  // (fail-closed, never throws). Apply without relayDir throws above, so
  // the no-relayDir path below only serves dry-run reclaimable estimates.
  // Photo bytes reclaimed fold into bytesReclaimed; the ref scan decodes via decodeChunk and skips
  // undecodable chunks (torn/orphan garbage) without failing the sweep.
  const photoOrphans: string[] = [];
  const photoRemoved: string[] = [];
  const photoMissing: { ref: string; chunk: string }[] = [];
  if (opts.deepPhoto) {
    const referenced = new Set<string>();
    const refChunk = new Map<string, string>();
    let warmNames: string[] = [];
    try {
      warmNames = readdirSync(warm).filter((f: string) => f.endsWith('.chk')).sort();
    } catch { warmNames = []; }
    for (const f of warmNames) {
      try {
        const buf = readFileSync(join(warm, f));
        const header = decodeHeader(buf);
        const dict = (header.flags & DICT_FLAG) !== 0
          ? loadDictFor(dictDir, header.dictId) ?? undefined
          : undefined;
        const { rows } = decodeChunk(buf, dict);
        for (const r of rows) {
          const m = PHOTO_SHA_RE.exec(r.body);
          if (m) { referenced.add(m[1]); if (!refChunk.has(m[1])) refChunk.set(m[1], f); }
        }
      } catch { /* undecodable chunk: contributes no refs, never fails the sweep */ }
    }
    let photoNames: string[] = [];
    try {
      photoNames = readdirSync(join(outDir, 'photo')).sort();
    } catch { photoNames = []; } // no photo dir yet: nothing orphaned
    const photoSet = new Set(photoNames);
    // Relay ack per sha: without relayDir (dry-run only: apply throws above)
    // counts as acked for the reclaimable estimate; a present relayDir needs
    // the sha in its `photo` map, and an absent/unreadable map retains everything.
    const relayPhoto = opts.relayDir ? readRelayPhotoMap(opts.relayDir) : null;
    const acked = (sha: string): boolean => {
      if (!opts.relayDir) return true;
      if (relayPhoto === null) return false;
      if (Object.prototype.hasOwnProperty.call(relayPhoto, sha)) return true;
      return Object.values(relayPhoto).some((v) => typeof v === 'string' && v.includes(sha));
    };
    for (const f of photoNames) {
      const m = /^([0-9a-f]{64})\.bin$/.exec(f);
      if (!m || referenced.has(m[1])) continue;
      const sha = m[1];
      const files = [`photo/${sha}.bin`];
      if (photoSet.has(`thumb-${sha}.jpg`)) files.push(`photo/thumb-${sha}.jpg`);
      if (photoSet.has(`thumb-${sha}.json`)) files.push(`photo/thumb-${sha}.json`);
      photoOrphans.push(...files);
      const deletable = !dryRun && acked(sha);
      for (const rel of files) {
        let size = 0;
        try { size = statSync(join(outDir, rel)).size; } catch { continue; }
        if (dryRun) {
          if (acked(sha)) bytesReclaimed += size;
        } else if (deletable) {
          try {
            unlinkSync(join(outDir, rel));
            photoRemoved.push(rel);
            bytesReclaimed += size;
          } catch { /* raced delete: ignore */ }
        }
      }
    }
    for (const sha of referenced) {
      if (!photoSet.has(`${sha}.bin`)) photoMissing.push({ ref: `photo:sha256:${sha}`, chunk: refChunk.get(sha) ?? '' });
    }
  }
  // Tmp/state litter: crashed writers leave <name>.tmp.<pid> / <name>.tmp
  // fragments behind (chunk, manifest, tar, dict, thumb, ship-index writes
  // all stage through a .tmp name). They are never referenced by the
  // manifest, so sweep collects them here. Live data never carries a .tmp
  // fragment in its name, and the dict-survey keep above still gates every
  // real dict delete: this only removes tmp fragments, never live dicts.
  const litter: string[] = [];
  const litterRemoved: string[] = [];
  for (const sub of ['warm', 'cold', 'dicts', '.']) {
    const dir = sub === '.' ? outDir : join(outDir, sub);
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((f: string) => f.includes('.tmp')).sort();
    } catch { continue; } // dir absent: nothing littered here
    for (const f of names) {
      const rel = sub === '.' ? f : `${sub}/${f}`;
      litter.push(rel);
      if (!dryRun) {
        try {
          unlinkSync(join(dir, f));
          litterRemoved.push(rel);
        } catch { /* raced delete: ignore */ }
      }
    }
  }
  return { orphans, removed, skippedUnacked, dictOrphans, dictsRemoved, dictBytesReclaimed, photoOrphans, photoRemoved, photoMissing, litter, litterRemoved, bytesReclaimed, dryRun, chunks, bytes };
}

export interface StatusInfo {
  chunks: number;
  bytes: number;
  unacked: number;
  orphans: number;
  orphanBytes: number;
  warmChunks: number;
  warmBytes: number;
  coldSegments: number;
  coldChunks: number;
  coldBytes: number;
}

export function statusInfo(outDir: string, relayDir?: string): StatusInfo {
  const warm = join(outDir, 'warm');
  mkdirSync(warm, { recursive: true });
  const { manifest } = loadManifest(outDir);
  const refs = new Set(manifest.chunks.map((e) => e.file));
  let bytes = 0;
  for (const e of manifest.chunks) bytes += e.bytes;
  // Warm bytes: referenced chunks present on disk (live working set).
  let warmChunks = 0;
  let warmBytes = 0;
  let orphans = 0;
  let orphanBytes = 0;
  try {
    for (const f of readdirSync(warm).filter((f: string) => f.endsWith('.chk'))) {
      let size = 0;
      try { size = statSync(join(warm, f)).size; } catch { continue; }
      if (!refs.has(f)) {
        orphans++;
        orphanBytes += size;
      } else {
        warmChunks++;
        warmBytes += size;
      }
    }
  } catch { /* no warm dir entries */ }
  // Cold bytes: tar segments listed in the manifest and present on disk.
  const listed = new Set((manifest.cold ?? []).map((s) => s.file));
  let coldSegments = 0;
  let coldChunks = 0;
  let coldBytes = 0;
  try {
    for (const f of readdirSync(join(outDir, 'cold')).filter((f: string) => f.endsWith('.tar'))) {
      if (!listed.has(f)) {
        orphans++;
        try { orphanBytes += statSync(join(outDir, 'cold', f)).size; } catch { /* ignore */ }
        continue;
      }
      coldSegments++;
      coldChunks += manifest.cold?.find((s) => s.file === f)?.chunks.length ?? 0;
      try { coldBytes += statSync(join(outDir, 'cold', f)).size; } catch { /* ignore */ }
    }
  } catch { /* no cold dir yet */ }
  let unacked: number;
  if (!relayDir) {
    unacked = manifest.chunks.length;
  } else {
    try {
      const remote = readRelayIndex(relayDir);
      const have = new Set(Object.keys(remote.chunks));
      unacked = manifest.chunks.filter((e) => !have.has(e.sha256)).length;
    } catch {
      unacked = manifest.chunks.length;
    }
  }
  return { chunks: manifest.chunks.length, bytes, unacked, orphans, orphanBytes, warmChunks, warmBytes, coldSegments, coldChunks, coldBytes };
}
