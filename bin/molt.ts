#!/usr/bin/env bun
// bin/molt — seal/ship/find over archive directories.
//   molt seal <hot.jsonl|hot.db> <outDir>
//   molt ship <outDir> <relayDir> [--blobs]
//   molt find <outDir> <trxId>
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { findTrx } from '../src/find.js';

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
  } else {
    fail('usage: molt <seal|ship|find> ...');
  }
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
