// ext/fetch-sqlite.ts — download + verify the official SQLite amalgamation.
//
// SQLite 3.53.4 (version number 3530400):
//   URL:      https://www.sqlite.org/2026/sqlite-amalgamation-3530400.zip
//   size:     2946650 bytes
//   sha256:   1e71ddf93849c6a6ecf58b827c0692073d2dd7ee40196158068f7b29f422e87d
//   sha3-256: 628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e
//             (as published at https://www.sqlite.org/download.html; the script
//              pins and verifies the sha256 above, computed over the same bytes,
//              plus the byte size, so a wrong/truncated zip fails loudly)
// Extracts { sqlite3.c, sqlite3.h, sqlite3ext.h, shell.c } into
// ext/amalg/sqlite-amalgamation-3530400/ — a git-ignored, per-machine local
// artifact (see .gitignore + docs/compat.md). Never committed, never fetched
// at build time by anything else.
// Per-file sha256, verified after extraction:
//   shell.c      8011ed018aa12969f93573b7bb1eae2d939d64d0f451b297ff847a0211c85179
//   sqlite3.c    b1dd5d74ec7f29055a6684fa06fb3c2f6821c87dd38f9a458dfd2e8a1db28189
//   sqlite3.h    919e7f2e8ed1d8f56ac17b412b8971c76aa5d1a879752cc6058f75e7d5910e1d
//   sqlite3ext.h ac9645e5c9ff0cf176efdd6e75cb5e98f46295d38e02db5c4d208826a39ab4be
//
// Usage: bun run fetch-sqlite
// Idempotent: when all four files already exist with matching hashes the
// download is skipped; corrupt/partial files trigger a fresh download.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const AMALG_URL = 'https://www.sqlite.org/2026/sqlite-amalgamation-3530400.zip';
const AMALG_SIZE = 2946650;
const AMALG_SHA256 = '1e71ddf93849c6a6ecf58b827c0692073d2dd7ee40196158068f7b29f422e87d';
const AMALG_DIR = 'sqlite-amalgamation-3530400';
const WANT: Record<string, string> = {
  'sqlite3.c': 'b1dd5d74ec7f29055a6684fa06fb3c2f6821c87dd38f9a458dfd2e8a1db28189',
  'sqlite3.h': '919e7f2e8ed1d8f56ac17b412b8971c76aa5d1a879752cc6058f75e7d5910e1d',
  'sqlite3ext.h': 'ac9645e5c9ff0cf176efdd6e75cb5e98f46295d38e02db5c4d208826a39ab4be',
  'shell.c': '8011ed018aa12969f93573b7bb1eae2d939d64d0f451b297ff847a0211c85179',
};

const here = dirname(fileURLToPath(import.meta.url));
const destDir = join(here, 'amalg', AMALG_DIR);

function sha256Hex(bytes: Uint8Array): string {
  const h = new Bun.CryptoHasher('sha256');
  h.update(bytes);
  return h.digest('hex');
}

async function sha256File(path: string): Promise<string> {
  return sha256Hex(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

async function destVerified(): Promise<boolean> {
  for (const [name, hash] of Object.entries(WANT)) {
    const p = join(destDir, name);
    if (!existsSync(p)) return false;
    if ((await sha256File(p)) !== hash) return false;
  }
  return true;
}

async function download(): Promise<Uint8Array> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(AMALG_URL, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength !== AMALG_SIZE)
        throw new Error(`size mismatch: got ${bytes.byteLength}, want ${AMALG_SIZE}`);
      const hex = sha256Hex(bytes);
      if (hex !== AMALG_SHA256) throw new Error(`sha256 mismatch: got ${hex}`);
      return bytes;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) console.log(`fetch-sqlite: attempt ${attempt} failed (${e}); retrying...`);
    }
  }
  throw lastErr;
}

function extractZip(zipPath: string): void {
  const members = Object.keys(WANT).map((n) => `${AMALG_DIR}/${n}`);
  // Preferred: system unzip (exact members, junk paths, overwrite).
  const r = Bun.spawnSync(['unzip', '-o', '-j', zipPath, ...members, '-d', destDir], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (r.exitCode === 0) return;
  const out = (r.stdout?.toString() ?? '') + (r.stderr?.toString() ?? '');
  if (process.platform === 'win32') {
    // Fallback for MinGW-less Windows: PowerShell Expand-Archive, then copy.
    const tmp = join(tmpdir(), `sqlite-amalg-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const ps = Bun.spawnSync(
      ['powershell', '-NoProfile', '-Command', `Expand-Archive -Force '${zipPath}' '${tmp}'`],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    );
    if (ps.exitCode !== 0)
      throw new Error(`unzip failed (${out.trim()}) and Expand-Archive failed (${ps.stderr?.toString().trim()})`);
    for (const name of Object.keys(WANT))
      Bun.write(join(destDir, name), Bun.file(join(tmp, AMALG_DIR, name)));
    rmSync(tmp, { recursive: true, force: true });
    return;
  }
  throw new Error(`unzip failed (exit ${r.exitCode}): ${out.trim()}`);
}

if (await destVerified()) {
  console.log(`fetch-sqlite: already fetched + verified: ${destDir}`);
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
const bytes = await download();
const zipPath = join(tmpdir(), `sqlite-amalgamation-3530400-${process.pid}.zip`);
try {
  writeFileSync(zipPath, bytes);
  extractZip(zipPath);
  for (const [name, hash] of Object.entries(WANT)) {
    const got = await sha256File(join(destDir, name));
    if (got !== hash) {
      rmSync(join(destDir, name), { force: true });
      throw new Error(`extracted ${name} failed hash check (got ${got}); re-run fetch-sqlite`);
    }
  }
  console.log(`fetch-sqlite: verified 4 files in ${destDir}`);
} finally {
  rmSync(zipPath, { force: true });
}
