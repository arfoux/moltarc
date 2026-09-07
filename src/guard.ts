import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'fs';
import { basename, dirname } from 'path';

const SHA_RE = /^[0-9a-f]{64}$/;
const CHUNK_RE = /^\w[\w.-]*\.chk$/;

export function assertSha(s: string): void {
  if (typeof s !== 'string' || !SHA_RE.test(s)) throw new Error(`bad sha: ${s}`);
}

export function assertChunkName(f: string): void {
  if (typeof f !== 'string' || f.length === 0) throw new Error(`bad chunk name: ${f}`);
  if (f.includes('/') || f.includes('\\') || f.includes('..')) throw new Error(`bad chunk name: ${f}`);
  const base = basename(f);
  if (base !== f) throw new Error(`bad chunk name: ${f}`);
  if (!CHUNK_RE.test(base)) throw new Error(`bad chunk name: ${f}`);
}

function fsyncFile(p: string): void {
  const fd = openSync(p, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function fsyncDir(p: string): void {
  try {
    const fd = openSync(p, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* Windows: dir fsync unsupported, rename is enough */ }
}

export function atomicWrite(dest: string, data: Buffer | string): void {
  const tmp = `${dest}.tmp.${process.pid}`;
  writeFileSync(tmp, data);
  fsyncFile(tmp);
  renameSync(tmp, dest);
  fsyncDir(dirname(dest));
}

