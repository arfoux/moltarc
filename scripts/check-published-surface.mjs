#!/usr/bin/env node
// check-published-surface.mjs — deterministic guard for the npm/GPR published surface.
// No network: raw GitHub URL shape is checked locally; HTTP status was verified manually
// when the gallery was introduced. Fails on relative images, broken local links,
// missing engines/root docs, image assets in the tarball, or missing shipped docs.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const REPO = 'moltarc';
const PREFIX = `https://raw.githubusercontent.com/arfoux/${REPO}/main/`;
const problems = [];

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (!pkg.engines?.bun) problems.push('package.json: engines.bun missing');

const readme = readFileSync('README.md', 'utf8');
const images = [
  ...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)|<img\s+[^>]*src=["']([^"']+)["']/g),
].map((m) => m[1] || m[2]);
if (images.length === 0) problems.push('README.md: no gallery images found');
for (const url of images) {
  if (!url.startsWith(PREFIX)) problems.push(`README.md: image not hosted at ${PREFIX}: ${url}`);
}

// Root markdown linked from README must ship too, or the published README has dead links.
const rootDocs = [
  ...new Set(
    [...readme.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)]
      .map((m) => m[1])
      .filter((p) => !p.includes('/')),
  ),
];
const docs = readdirSync('docs')
  .filter((f) => f.endsWith('.md'))
  .map((f) => `docs/${f}`);
const markdown = [...new Set(['README.md', ...rootDocs.filter(existsSync), ...docs])];
for (const file of markdown) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = m[1].split('#')[0].trim();
    if (!target || /^(https?:|mailto:|data:)/.test(target)) continue;
    let local;
    try { local = decodeURIComponent(target); } catch { local = target; }
    if (!existsSync(resolve(dirname(file), local))) {
      problems.push(`${file}: broken local link ${target}`);
    }
  }
}

let packed;
try {
  packed = JSON.parse(execSync('npm pack --dry-run --json', { encoding: 'utf8', shell: true }));
} catch {
  problems.push('npm pack --dry-run failed');
}
if (packed) {
  const files = packed[0].files.map((f) => f.path);
  const assets = files.filter((f) => /\.(png|jpe?g|gif|svg|webp)$/i.test(f));
  if (assets.length) problems.push(`tarball ships image assets: ${assets.join(', ')}`);
  for (const required of ['README.md', 'CHANGELOG.md', 'LICENSE', ...rootDocs]) {
    if (!files.includes(required)) problems.push(`tarball missing ${required}`);
  }
  if (!files.some((f) => f.startsWith('docs/') && f.endsWith('.md'))) {
    problems.push('tarball missing docs/*.md');
  }
}

if (problems.length) {
  console.error('Published-surface check failed:');
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log(`Published-surface OK (${images.length} images, ${docs.length} docs, ${rootDocs.length} root docs)`);
