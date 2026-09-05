#!/usr/bin/env bun
// bin/moltarc — seal/ship/find/verify/repair over archive directories.
//   moltarc seal <hot.jsonl|hot.db> <outDir>
//   moltarc ship <outDir> <relayDir> [--blobs]
//   moltarc find <outDir> <trxId>
//   moltarc verify <outDir>
//   moltarc repair <outDir> <relayDir>
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { findTrx } from '../src/find.js';
import { statusInfo, sweep } from '../src/gc.js';
import { forgetChunks, mergeCold, sweepCold } from '../src/cold.js';
import { verifyFull, repairAll } from '../src/verify.js';
import type { VerifyFullResult } from '../src/verify.js';
function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function usageLines(): string[] {
  return [
    'usage: moltarc <seal|ship|find|verify|repair|status|gc|merge|forget|coldg> ...',
    '  moltarc seal <hot.jsonl|hot.db> <outDir>',
    '  moltarc ship <outDir> <relayDir> [--blobs]',
    '  moltarc find <outDir> <trxId>',
    '  moltarc verify <outDir>',
    '  moltarc repair <outDir> <relayDir>',
    '  moltarc status <outDir> [relayDir]',
    '  moltarc gc <outDir> [relayDir] [--apply]',
    '  moltarc merge <outDir>',
    '  moltarc forget <outDir> <relayDir> <chunk> [chunk...]',
    '  moltarc coldg <outDir> [--apply]',
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
  const count = (s: string) => v.items.filter((i) => i.status === s).length;
  console.log(`verify: ${count('OK')} ok, ${count('CORRUPT')} corrupt, ${count('MISSING')} missing, ${count('QUARANTINED')} quarantined, ${v.chain.length} chain break(s) — ${v.ok ? 'OK' : 'FAIL'}`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'seal') {
    const [hot, outDir] = rest;
    if (!hot || !outDir) fail('usage: moltarc seal <hot.jsonl|hot.db> <outDir>');
    const r = await seal({ hotDb: hot, outDir });
    console.log(`sealed ${r.rowsSealed} rows -> ${r.chunks.length} chunk(s), sealed_upto_seq=${r.sealedUptoSeq}`);
  } else if (cmd === 'ship') {
    const [outDir, relayDir, flag] = rest;
    if (!outDir || !relayDir) fail('usage: moltarc ship <outDir> <relayDir> [--blobs]');
    const r = await ship({ outDir, relayDir, includeBlobs: flag === '--blobs' });
    console.log(`shipped ${r.sent.length} chunk(s), skipped ${r.skipped.length}, ${r.bytes}B`);
  } else if (cmd === 'find') {
    const [outDir, trxId] = rest;
    if (!outDir || !trxId) fail('usage: moltarc find <outDir> <trxId>');
    const f = findTrx({ outDir, trxId });
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
  } else if (cmd === 'coldg') {
    const [outDir, flag] = rest;
    if (!outDir) fail('usage: moltarc coldg <outDir> [--apply]');
    const r = sweepCold(outDir, { dryRun: flag !== '--apply' });
    if (r.dryRun) console.log(`dry-run: ${r.pruned.length} pruned, ${r.repacked.length} repacked, ${r.bytesReclaimed}B reclaimable`);
    else console.log(`swept cold: pruned ${r.pruned.length}, repacked ${r.repacked.length}, reclaimed ${r.bytesReclaimed}B`);
    for (const f of r.pruned) console.log(`pruned ${f}`);
    for (const s of r.repacked) console.log(`repacked ${s.file} ${s.before}B -> ${s.after}B`);
  } else if (cmd === 'gc') {
    const flags = rest.filter((a) => a.startsWith('--'));
    const positional = rest.filter((a) => !a.startsWith('--'));
    const apply = flags.includes('--apply');
    const [outDir, relayDir] = positional;
    if (!outDir || positional.length > 2 || flags.some((f) => f !== '--apply')) fail('usage: moltarc gc <outDir> [relayDir] [--apply]');
    const r = sweep(outDir, { dryRun: !apply, relayDir });
    if (r.dryRun) console.log(`dry-run: ${r.orphans.length} orphan(s), ${r.skippedUnacked.length} retained, ${r.dictOrphans.length} dict orphan(s), ${r.bytesReclaimed + r.dictBytesReclaimed}B reclaimable`);
    else console.log(`swept ${r.removed.length} chunk(s), ${r.dictsRemoved.length} dict(s), reclaimed ${r.bytesReclaimed + r.dictBytesReclaimed}B`);
    for (const f of r.orphans) console.log(`orphan ${f}`);
    for (const f of r.removed) console.log(`removed ${f}`);
    for (const f of r.skippedUnacked) console.log(`retained ${f}`);
    for (const f of r.dictOrphans) console.log(`dict-orphan ${f}`);
    for (const f of r.dictsRemoved) console.log(`dict-removed ${f}`);
  } else if (cmd === 'repair') {
    const [outDir, relayDir] = rest;
    if (!outDir || !relayDir) fail('usage: moltarc repair <outDir> <relayDir>');
    const r = repairAll(outDir, relayDir);
    for (const f of r.repaired) console.log(`REPAIRED ${f}`);
    for (const f of r.failed) console.log(`FAILED ${f.file} (${f.error})`);
    printVerify(r.verify);
    console.log(`repair: ${r.repaired.length} repaired, ${r.failed.length} failed — ${r.ok ? 'OK' : 'FAIL'}`);
    if (!r.ok) process.exitCode = 1;
  } else if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    for (const line of usageLines()) console.log(line);
  } else {
    usage();
  }
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
