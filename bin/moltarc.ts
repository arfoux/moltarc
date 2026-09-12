#!/usr/bin/env bun
// bin/moltarc — seal/ship/find/verify/repair over archive directories.
//   moltarc seal <hot.jsonl|hot.db> <outDir> [--table <name>]
//   moltarc ship <outDir> <relayDir> [--blobs]
//   moltarc find <outDir> <id>
//   moltarc verify <outDir>
//   moltarc repair <outDir> <relayDir>
//   moltarc restore-from-cold <outDir>
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { readTar } from '../src/cold.js';
import { buildManifest, saveManifestAtomic } from '../src/manifest.js';
import { clearFindCaches, findCold, findTrx } from '../src/find.js';
import { statusInfo, sweep } from '../src/gc.js';
import { forgetChunks, mergeCold, sweepCold } from '../src/cold.js';
import { printChainGaps, repairAll, verifyFull } from '../src/verify.js';
import type { VerifyFullResult } from '../src/verify.js';
import { checkUnacked } from '../src/alerts.js';
import { assertChunkName } from '../src/guard.js';
import { syncFromPeer } from '../src/p2p.js';
import { queryAsOf } from '../src/timetravel.js';
import { CURRENT_MANIFEST_VERSION, migrate, planMigration, requireMigrated } from '../src/migrate.js';
function fail(err: unknown): never {
  if (err instanceof Error) {
    console.error(err.message);
    if (err.stack) console.error(err.stack);
  } else {
    console.error(String(err));
  }
  process.exit(1);
}

function usageLines(): string[] {
  return [
    'usage: moltarc <seal|ship|find|find-cold|verify|repair|status|gc|merge|forget|coldg|restore-from-cold|check|p2p-sync|asof|migrate> [--verbose] ...',
    '  moltarc seal <hot.jsonl|hot.db> <outDir> [--table <name>]',
    '  moltarc ship <outDir> <relayDir> [--blobs]',
    '  moltarc find <outDir> <id>',
    '  moltarc find-cold <outDir> <id>',
    '  moltarc verify <outDir>',
    '  moltarc repair <outDir> <relayDir>',
    '  moltarc status <outDir> [relayDir]',
    '  moltarc gc <outDir> [relayDir] [--apply] [--deep-photo]',
    '  moltarc merge <outDir>',
    '  moltarc forget <outDir> <relayDir> <chunk> [chunk...]',
    '  moltarc coldg <outDir> [--apply]',
    '  moltarc restore-from-cold <outDir> [--apply]',
    '  moltarc check <outDir> <relayDir>',
    '  moltarc p2p-sync <peerUrl> <outDir> [--token <t>]',
    '  moltarc asof <outDir> [<ts>] [--seq <n>]',
    '  moltarc migrate <outDir> [--dry-run]',
  ];
}

function usage(): never {
  for (const line of usageLines()) console.error(line);
  process.exit(1);
}

function printVerify(v: VerifyFullResult): void {
  console.log(`manifest: ${v.manifest.ok ? 'OK' : 'CORRUPT'} (${v.manifest.detail})`);
  for (const item of v.items) {
    console.log(item.status === 'OK' ? `OK ${item.file}` : `${item.status} ${item.file} (${item.reason})`);
  }
  if (v.chain.length === 0) {
    console.log('chain: OK');
  } else {
    for (const b of v.chain) console.log(`CHAIN ${b.table} ${b.prev} -> ${b.next} gap`);
  }
  // Gap warnings print via the verify helper; ok ignores gaps, so a
  // gaps-only walk keeps exit 0.
  printChainGaps(v);
  const count = (s: string) => v.items.filter((i) => i.status === s).length;
  console.log(`verify: ${count('OK')} ok, ${count('CORRUPT')} corrupt, ${count('MISSING')} missing, ${count('QUARANTINED')} quarantined, ${v.chain.length} chain break(s) — ${v.ok ? 'OK' : 'FAIL'}`);
}

function restoreFromCold(outDir: string, opts: { dryRun?: boolean } = {}): string[] {
  const dryRun = opts.dryRun ?? true;
  const coldDir = join(outDir, 'cold');
  let segs: string[];
  try {
    segs = readdirSync(coldDir).filter((f) => f.endsWith('.tar')).sort();
  } catch {
    segs = [];
  }
  if (segs.length === 0) fail(`restore-from-cold: no cold segments in ${coldDir}`);
  // Validate member names before touching disk: chunk members via the shared
  // gate, dict members by exact path shape. A hostile tar aborts, never writes.
  const DICT_MEMBER_RE = /^dicts\/dict-[0-9a-f]{8}\.dict$/;
  const plan: { seg: string; chunks: string[]; dicts: string[] }[] = [];
  for (const seg of segs) {
    const members = readTar(readFileSync(join(coldDir, seg)));
    const chunks: string[] = [];
    const dicts: string[] = [];
    for (const m of members) {
      if (m.name.startsWith('dicts/')) {
        if (!DICT_MEMBER_RE.test(m.name)) fail(`restore-from-cold: bad dict member ${m.name} in ${seg}`);
        dicts.push(m.name);
      } else {
        assertChunkName(m.name);
        chunks.push(m.name);
      }
    }
    chunks.sort();
    dicts.sort();
    plan.push({ seg, chunks, dicts });
  }
  if (dryRun) {
    const n = plan.reduce((a, p) => a + p.chunks.length, 0);
    console.log(`dry-run: would restore ${n} chunk(s) + ${plan.reduce((a, p) => a + p.dicts.length, 0)} dict(s) from ${plan.length} segment(s)`);
    return [];
  }
  // Downgrade guard: refuse to rebuild an old manifest in place (dry-run
  // above stays read-only and skips the guard).
  requireMigrated(outDir);
  const warm = join(outDir, 'warm');
  const dicts = join(outDir, 'dicts');
  mkdirSync(warm, { recursive: true });
  mkdirSync(dicts, { recursive: true });
  const cold: { file: string; chunks: string[]; bytes: number }[] = [];
  for (const p of plan) {
    const full = join(coldDir, p.seg);
    const members = readTar(readFileSync(full));
    for (const m of members) {
      if (m.name.startsWith('dicts/')) {
        writeFileSync(join(outDir, m.name), Buffer.from(m.data));
      } else {
        writeFileSync(join(warm, m.name), Buffer.from(m.data));
      }
    }
    cold.push({ file: p.seg, chunks: p.chunks, bytes: statSync(full).size });
  }
  cold.sort((a, b) => (a.file < b.file ? -1 : 1));
  const manifest = buildManifest(outDir);
  manifest.cold = cold;
  saveManifestAtomic(outDir, manifest);
  clearFindCaches();
  return plan.map((p) => p.seg);
}


async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2).filter((a) => a !== '--verbose');
  if (cmd === 'seal') {
    const tableIdx = rest.indexOf('--table');
    let table: string | undefined;
    let args = rest;
    if (tableIdx >= 0) {
      table = rest[tableIdx + 1];
      if (!table) fail('usage: moltarc seal <hot.jsonl|hot.db> <outDir> [--table <name>]');
      args = [...rest.slice(0, tableIdx), ...rest.slice(tableIdx + 2)];
    }
    const [hot, outDir] = args;
    if (!hot || !outDir) fail('usage: moltarc seal <hot.jsonl|hot.db> <outDir> [--table <name>]');
    const r = await seal({ hotDb: hot, outDir, ...(table !== undefined ? { table } : {}) });
    console.log(`sealed ${r.rowsSealed} rows -> ${r.chunks.length} chunk(s), sealed_upto_seq=${r.sealedUptoSeq}`);
    if (r.rowsReplaced > 0) console.log(`replaced ${r.rowsReplaced} row(s) (same device:seq:table, new body won)`);
    if (r.rowsSkipped > 0) console.log(`skipped ${r.rowsSkipped} row(s) (already sealed)`);
    if (r.rowsMalformed > 0) console.log(`malformed ${r.rowsMalformed} row(s) (see SealResult)`);
  } else if (cmd === 'ship') {
    const flags = rest.filter((a) => a.startsWith('--'));
    const positional = rest.filter((a) => !a.startsWith('--'));
    const [outDir, relayDir] = positional;
    if (!outDir || !relayDir || positional.length > 2 || flags.some((f) => f !== '--blobs')) fail('usage: moltarc ship <outDir> <relayDir> [--blobs]');
    const r = await ship({ outDir, relayDir, includeBlobs: flags.includes('--blobs') });
    console.log(`shipped ${r.sent.length} chunk(s), skipped ${r.skipped.length}, ${r.bytes}B`);
  } else if (cmd === 'find') {
    const [outDir, trxId] = rest;
    if (!outDir || !trxId) fail('usage: moltarc find <outDir> <id>');
    const f = findTrx({ outDir, trxId });
    console.log(JSON.stringify(f.row));
    console.log(`chunk ${f.chunk} fetched ${f.chunksFetched}`);
  } else if (cmd === 'find-cold') {
    const [outDir, trxId] = rest;
    if (!outDir || !trxId) fail('usage: moltarc find-cold <outDir> <id>');
    const f = findCold({ outDir: outDir as string, trxId: trxId as string });
    console.log(JSON.stringify(f.row));
    console.log(`chunk ${f.chunk} fetched ${f.chunksFetched}`);
  } else if (cmd === 'verify') {
    const [outDir] = rest;
    if (!outDir) fail('usage: moltarc verify <outDir>');
    const v = verifyFull(outDir);
    printVerify(v);
    if (!v.ok) process.exitCode = 1;
  } else if (cmd === 'status') {
    const [outDir, relayDir] = rest;
    if (!outDir) fail('usage: moltarc status <outDir> [relayDir]');
    const s = statusInfo(outDir, relayDir);
    console.log(`chunks: ${s.chunks}`);
    console.log(`bytes: ${s.bytes}`);
    console.log(`warm: ${s.warmChunks} chunk(s), ${s.warmBytes}B`);
    console.log(`cold: ${s.coldSegments} segment(s), ${s.coldChunks} chunk(s), ${s.coldBytes}B`);
    console.log(`unacked: ${s.unacked}`);
    console.log(`orphans: ${s.orphans} (${s.orphanBytes}B)`);
  } else if (cmd === 'merge') {
    const [outDir] = rest;
    if (!outDir) fail('usage: moltarc merge <outDir>');
    const r = mergeCold(outDir);
    if (!r.segment) console.log('merge: nothing new to pack');
    else console.log(`merged ${r.chunks.length} chunk(s) -> cold/${r.segment} (${r.bytes}B)`);
  } else if (cmd === 'forget') {
    const [outDir, relayDir, ...files] = rest;
    if (!outDir || !relayDir || files.length === 0) fail('usage: moltarc forget <outDir> <relayDir> <chunk> [chunk...]');
    const r = forgetChunks(outDir, files, relayDir);
    console.log(`forgot ${r.removed.length} chunk(s)`);
    for (const f of r.removed) console.log(`forgot ${f}`);
    console.log('note: bytes remain until gc --apply + coldg --apply');
  } else if (cmd === 'coldg') {
    const [outDir, flag] = rest;
    if (!outDir) fail('usage: moltarc coldg <outDir> [--apply]');
    const r = sweepCold(outDir, { dryRun: flag !== '--apply' });
    if (r.dryRun) console.log(`dry-run: ${r.pruned.length} pruned, ${r.repacked.length} repacked, ${r.bytesReclaimed}B reclaimable`);
    else console.log(`swept cold: pruned ${r.pruned.length}, repacked ${r.repacked.length}, reclaimed ${r.bytesReclaimed}B`);
    for (const f of r.pruned) console.log(`pruned ${f}`);
    for (const s of r.repacked) console.log(`repacked ${s.file} ${s.before}B -> ${s.after}B`);
    for (const f of r.corrupt ?? []) console.log(`corrupt ${f} (left on disk, needs repair)`);
  } else if (cmd === 'gc') {
    const flags = rest.filter((a) => a.startsWith('--'));
    const positional = rest.filter((a) => !a.startsWith('--'));
    const apply = flags.includes('--apply');
    const deepPhoto = flags.includes('--deep-photo');
    const [outDir, relayDir] = positional;
    if (!outDir || positional.length > 2 || flags.some((f) => f !== '--apply' && f !== '--deep-photo')) fail('usage: moltarc gc <outDir> [relayDir] [--apply] [--deep-photo]');
    if (!relayDir) console.log('note: no relayDir given, ack state unknown — all orphans retained (fail-closed)');
    const r = sweep(outDir, { dryRun: !apply, relayDir, deepPhoto });
    if (r.dryRun) console.log(`dry-run: ${r.orphans.length} orphan(s), ${r.skippedUnacked.length} retained, ${r.dictOrphans.length} dict orphan(s), ${r.bytesReclaimed + r.dictBytesReclaimed}B reclaimable`);
    else console.log(`swept ${r.removed.length} chunk(s), ${r.dictsRemoved.length} dict(s), reclaimed ${r.bytesReclaimed + r.dictBytesReclaimed}B`);
    for (const f of r.orphans) console.log(`orphan ${f}`);
    for (const f of r.removed) console.log(`removed ${f}`);
    for (const f of r.skippedUnacked) console.log(`retained ${f}`);
    for (const f of r.dictOrphans) console.log(`dict-orphan ${f}`);
    for (const f of r.dictsRemoved) console.log(`dict-removed ${f}`);
    for (const f of r.photoOrphans) console.log(`photo-orphan ${f}`);
    for (const f of r.photoRemoved) console.log(`photo-removed ${f}`);
    if (r.litter.length > 0) console.log(`litter ${r.litter.length} tmp file(s) collected`);
  } else if (cmd === 'repair') {
    const [outDir, relayDir] = rest;
    if (!outDir || !relayDir) fail('usage: moltarc repair <outDir> <relayDir>');
    const r = repairAll(outDir, relayDir);
    for (const f of r.repaired) console.log(`REPAIRED ${f}`);
    for (const f of r.failed) console.log(`FAILED ${f.file} (${f.error})`);
    printVerify(r.verify);
    console.log(`repair: ${r.repaired.length} repaired, ${r.failed.length} failed — ${r.ok ? 'OK' : 'FAIL'}`);
    if (!r.ok) process.exitCode = 1;
  } else if (cmd === 'restore-from-cold') {
    const [outDir, flag] = rest;
    if (!outDir) fail('usage: moltarc restore-from-cold <outDir> [--apply]');
    const apply = flag === '--apply';
    if (!apply) {
      restoreFromCold(outDir, { dryRun: true });
      return;
    }
    const segs = restoreFromCold(outDir, { dryRun: false });
    console.log(`restored ${segs.length} segment(s) from cold`);
    for (const s of segs) console.log(`restored ${s}`);
  } else if (cmd === 'check') {
    const [outDir, relayDir] = rest;
    if (!outDir || !relayDir) fail('usage: moltarc check <outDir> <relayDir>');
    const a = checkUnacked(outDir, relayDir);
    console.log(`alerts: ${a.level} (unacked=${a.unacked} quarantined=${a.quarantined} free=${a.freeBytes}B)`);
    for (const r of a.reasons) console.log(`reason ${r}`);
    for (const u of a.unknown) console.log(`unknown ${u}`);
    process.exitCode = a.level === 'ok' ? 0 : a.level === 'warn' ? 1 : 2;
  } else if (cmd === 'p2p-sync') {
    const tokIdx = rest.indexOf('--token');
    let token: string | undefined;
    let args = rest;
    if (tokIdx >= 0) {
      token = rest[tokIdx + 1];
      if (!token) fail('usage: moltarc p2p-sync <peerUrl> <outDir> [--token <t>]');
      args = [...rest.slice(0, tokIdx), ...rest.slice(tokIdx + 2)];
    }
    const [peerUrl, outDir] = args;
    if (!peerUrl || !outDir || args.length > 2) fail('usage: moltarc p2p-sync <peerUrl> <outDir> [--token <t>]');
    const r = await syncFromPeer(peerUrl as string, outDir as string, { ...(token !== undefined ? { token } : {}) });
    console.log(`synced ${r.received.length} chunk(s), skipped ${r.skipped.length}, failed ${r.failed.length}, ${r.bytes}B`);
    for (const f of r.received) console.log(`received ${f}`);
    for (const f of r.failed) console.log(`failed ${f}`);
  } else if (cmd === 'asof') {
    const seqIdx = rest.indexOf('--seq');
    let seq: number | undefined;
    if (seqIdx >= 0) {
      seq = Number(rest[seqIdx + 1]);
      if (!Number.isFinite(seq)) fail('usage: moltarc asof <outDir> [<ts>] [--seq <n>]');
    }
    const positional = seqIdx >= 0 ? rest.filter((a, i) => !a.startsWith('--') && i !== seqIdx + 1) : rest.filter((a) => !a.startsWith('--'));
    const [outDir, tsArg] = positional;
    if (!outDir || (seq === undefined && tsArg === undefined)) fail('usage: moltarc asof <outDir> [<ts>] [--seq <n>]');
    const ts = seq === undefined ? Number(tsArg) : undefined;
    if (ts !== undefined && !Number.isFinite(ts)) fail('usage: moltarc asof <outDir> [<ts>] [--seq <n>]');
    const r = seq === undefined ? queryAsOf({ outDir: outDir as string, ts }) : queryAsOf({ outDir: outDir as string, seq });
    console.log(JSON.stringify(r.rows));
    const target = seq === undefined ? `ts=${ts}` : `seq=${seq}`;
    console.log(`asof ${r.rows.length} row(s) (${target}) from ${r.proof.chunksConsulted.length} chunk(s), pruned ${r.proof.chunksPruned}`);
    if (r.proof.skippedMissing > 0) {
      console.error(`asof PARTIAL: ${r.proof.skippedMissing} chunk(s) missing, result incomplete — refusing silent success`);
      process.exit(2);
    }
  } else if (cmd === 'migrate') {
    const flags = rest.filter((a) => a.startsWith('--'));
    const positional = rest.filter((a) => !a.startsWith('--'));
    const [outDir] = positional;
    if (!outDir || positional.length > 1 || flags.some((f) => f !== '--dry-run')) fail('usage: moltarc migrate <outDir> [--dry-run]');
    const dryRun = flags.includes('--dry-run');
    const before = planMigration(outDir);
    const r = migrate(outDir, { dryRun });
    console.log(`migrate: ${before.reason} (${before.entries} entries, ${before.stale.length} stale)`);
    if (!before.needs) console.log('already current — nothing to do');
    else if (dryRun) console.log(`dry-run: would rebuild ${before.entries} entries -> v${CURRENT_MANIFEST_VERSION}`);
    else console.log(`rebuilt ${r.entries} entries -> v${CURRENT_MANIFEST_VERSION}, backup ${r.backup}`);
  } else if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    for (const line of usageLines()) console.log(line);
  } else {
    usage();
  }
}
main().catch((e: unknown) => fail(e));
