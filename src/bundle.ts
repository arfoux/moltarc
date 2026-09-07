// moltarc bundle — atomic 1-text+N-refs manifest pack (qurban/pod pattern):
// one human-readable text plus N content refs linked by sha256 hash. hash
// primitives are import-only reuse from chunk.js; writes are tmp+rename.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { sha256hex, crc32c } from './chunk.js';
import { assertSha } from './guard.js';

export interface BundleMember {
  name: string;
  data: Buffer;
}

export interface BundleRef {
  name: string;
  sha256: string;
  crc32c: number;
  bytes: number;
}

export interface BundleManifest {
  version: 1;
  text: string;
  textSha256: string;
  refs: BundleRef[];
  createdAt: string;
}

export interface BundleVerify {
  ok: boolean;
  errors: string[];
}

export const BUNDLE_MANIFEST_FILE = 'manifest.json';
export const BUNDLE_REFS_DIR = 'refs';

function checkName(name: string): void {
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`packBundle: bad ref name: ${JSON.stringify(name)}`);
  }
}

function writeAtomic(dest: string, data: Buffer | string): void {
  const tmp = `${dest}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, dest);
}

// atomic pack: ref blobs land under refs/<sha256>, then the manifest links
// them by hash. duplicate ref names throw; empty member data throws.
export function packBundle(dir: string, text: string, members: BundleMember[]): BundleManifest {
  if (typeof text !== 'string') throw new Error('packBundle: text must be a string');
  const seen = new Set<string>();
  for (const m of members) {
    checkName(m.name);
    if (seen.has(m.name)) throw new Error(`packBundle: duplicate ref: ${m.name}`);
    seen.add(m.name);
    if (m.data.length === 0) throw new Error(`packBundle: empty ref data: ${m.name}`);
  }
  mkdirSync(join(dir, BUNDLE_REFS_DIR), { recursive: true });
  const refs: BundleRef[] = members.map((m) => {
    const sha256 = sha256hex(m.data);
    writeAtomic(join(dir, BUNDLE_REFS_DIR, sha256), m.data);
    return { name: m.name, sha256, crc32c: crc32c(m.data), bytes: m.data.length };
  });
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const manifest: BundleManifest = {
    version: 1,
    text,
    textSha256: sha256hex(Buffer.from(text, 'utf8')),
    refs,
    createdAt: new Date().toISOString(),
  };
  writeAtomic(join(dir, BUNDLE_MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function loadBundleManifest(dir: string): BundleManifest {
  return JSON.parse(readFileSync(join(dir, BUNDLE_MANIFEST_FILE), 'utf8')) as BundleManifest;
}

export function readBundleRef(dir: string, ref: BundleRef): Buffer {
  assertSha(ref.sha256);
  return readFileSync(join(dir, BUNDLE_REFS_DIR, ref.sha256));
}

// full hash-link check: text hash plus every ref file present with matching
// sha256 + crc32c + byte length. errors list every break; ok is all-clear.
export function verifyBundle(dir: string): BundleVerify {
  const errors: string[] = [];
  let m: BundleManifest;
  try {
    m = loadBundleManifest(dir);
  } catch {
    return { ok: false, errors: ['manifest unreadable'] };
  }
  if (m.version !== 1) errors.push('bad version');
  if (sha256hex(Buffer.from(m.text, 'utf8')) !== m.textSha256) errors.push('text hash mismatch');
  for (const r of m.refs) {
    let data: Buffer;
    try {
      assertSha(r.sha256);
      data = readFileSync(join(dir, BUNDLE_REFS_DIR, r.sha256));
    } catch {
      errors.push(`missing ref: ${r.name}`);
      continue;
    }
    if (sha256hex(data) !== r.sha256) errors.push(`sha mismatch: ${r.name}`);
    if (crc32c(data) !== r.crc32c) errors.push(`crc mismatch: ${r.name}`);
    if (data.length !== r.bytes) errors.push(`size mismatch: ${r.name}`);
  }
  return { ok: errors.length === 0, errors };
}
