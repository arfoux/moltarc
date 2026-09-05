// moltarc cas — content-addressed chunk store shared across archive forks.
// Identical sha bytes store once; per-owner ref files give the refcount, so
// two sealed forks link the same object and neither deletes it while the
// other still holds a ref. Pure fs, no sqlite, no native deps.
import { createHash } from 'crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const SHA_RE = /^[0-9a-f]{64}$/;

export function sha256hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function assertSha(sha: string): void {
  if (!SHA_RE.test(sha)) throw new Error(`cas: bad sha ${sha.slice(0, 32)}`);
}

function assertOwner(owner: string): string {
  const clean = owner.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  if (!clean) throw new Error('cas: empty owner');
  return clean;
}

function objectsDir(root: string): string {
  return join(root, 'objects');
}

function refDir(root: string, sha: string): string {
  return join(root, 'refs', sha);
}

function fsyncFile(p: string): void {
  const fd = openSync(p, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Store bytes once under their sha256; identical puts never rewrite.
export function casPut(root: string, data: Uint8Array): string {
  const buf = Buffer.from(data);
  const sha = sha256hex(buf);
  mkdirSync(objectsDir(root), { recursive: true });
  const dest = join(objectsDir(root), sha);
  if (!existsSync(dest)) {
    const tmp = `${dest}.tmp-${process.pid}`;
    writeFileSync(tmp, buf);
    fsyncFile(tmp);
    renameSync(tmp, dest);
  }
  return sha;
}

export function casHas(root: string, sha: string): boolean {
  assertSha(sha);
  return existsSync(join(objectsDir(root), sha));
}

// Read back stored bytes; throws on bad sha or missing object.
export function casGet(root: string, sha: string): Buffer {
  assertSha(sha);
  return readFileSync(join(objectsDir(root), sha));
}

// Record that owner archive references sha. Idempotent per owner.
// Throws when the blob is absent: forks share bytes that exist.
export function casLink(root: string, sha: string, owner: string): void {
  assertSha(sha);
  const who = assertOwner(owner);
  if (!existsSync(join(objectsDir(root), sha))) throw new Error(`cas: link missing object ${sha.slice(0, 12)}`);
  const dir = refDir(root, sha);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${who}.ref`);
  if (!existsSync(dest)) {
    const tmp = `${dest}.tmp-${process.pid}`;
    writeFileSync(tmp, `${who}\n`);
    fsyncFile(tmp);
    renameSync(tmp, dest);
  }
}

// Drop one owner's ref; missing ref is a no-op (idempotent unlink).
export function casUnlink(root: string, sha: string, owner: string): void {
  assertSha(sha);
  const who = assertOwner(owner);
  try { rmSync(join(refDir(root, sha), `${who}.ref`), { force: true }); } catch { /* idempotent */ }
}

export function casOwners(root: string, sha: string): string[] {
  assertSha(sha);
  let names: string[] = [];
  try { names = readdirSync(refDir(root, sha)); } catch { return []; }
  return names.filter((n) => n.endsWith('.ref')).map((n) => n.slice(0, -4)).sort();
}

export function casRefcount(root: string, sha: string): number {
  return casOwners(root, sha).length;
}

// Delete objects with zero refs (never touches referenced bytes).
// Returns the deleted shas, sorted.
export function casGc(root: string): string[] {
  let names: string[] = [];
  try { names = readdirSync(objectsDir(root)); } catch { return []; }
  const deleted: string[] = [];
  for (const name of names) {
    if (!SHA_RE.test(name)) continue;
    if (casRefcount(root, name) > 0) continue;
    try { rmSync(join(objectsDir(root), name), { force: true }); } catch { continue; }
    try { rmSync(refDir(root, name), { recursive: true, force: true }); } catch { /* empty ref dir */ }
    deleted.push(name);
  }
  return deleted.sort();
}
