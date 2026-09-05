#!/usr/bin/env bun
// bin/molt — seal/ship/find over archive directories.
//   molt seal <hot.jsonl|hot.db> <outDir>
//   molt ship <outDir> <relayDir> [--blobs]
//   molt find <outDir> <trxId>
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { findTrx } from '../src/find.js';
import { statusInfo, sweep } from '../src/gc.js';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'seal') {
    const [hot, outDir] = rest;
    if (!hot || !outDir) fail('usage: molt seal <hot.jsonl|hot.db> <outDir>');
    const r = await seal({ hotDb: hot, outDir });
    console.log(`sealed ${r.rowsSealed} rows -> ${r.chunks.length} chunk(s), sealed_upto_seq=${r.sealedUptoSeq}`);
  } else if (cmd === 'ship') {
    const [outDir, relayDir, flag] = rest;
    if (!outDir || !relayDir) fail('usage: molt ship <outDir> <relayDir> [--blobs]');
    const r = await ship({ outDir, relayDir, includeBlobs: flag === '--blobs' });
    console.log(`shipped ${r.sent.length} chunk(s), skipped ${r.skipped.length}, ${r.bytes}B`);
  } else if (cmd === 'find') {
    const [outDir, trxId] = rest;
    if (!outDir || !trxId) fail('usage: molt find <outDir> <trxId>');
    const f = findTrx({ outDir, trxId });
    console.log(JSON.stringify(f.row));
    console.log(`chunk ${f.chunk} fetched ${f.chunksFetched}`);
  } else if (cmd === 'status') {
    const [outDir, relayDir] = rest;
    if (!outDir) fail('usage: molt status <outDir> [relayDir]');
    const s = statusInfo(outDir, relayDir);
    console.log(`chunks: ${s.chunks}`);
    console.log(`bytes: ${s.bytes}`);
    console.log(`unacked: ${s.unacked}`);
    console.log(`orphans: ${s.orphans} (${s.orphanBytes}B)`);
  } else if (cmd === 'gc') {
    const [outDir, flag] = rest;
    if (!outDir) fail('usage: molt gc <outDir> [--apply]');
    const r = sweep(outDir, { dryRun: flag !== '--apply' });
    if (r.dryRun) console.log(`dry-run: ${r.orphans.length} orphan(s), ${r.bytesReclaimed}B reclaimable`);
    else console.log(`swept ${r.removed.length} orphan(s), reclaimed ${r.bytesReclaimed}B`);
    for (const f of r.orphans) console.log(`orphan ${f}`);
    console.log(`chunks: ${r.chunks} (${r.bytes}B)`);
  } else {
    fail('usage: molt <seal|ship|find|status|gc> ...');
  }
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
