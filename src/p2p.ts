import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { join } from 'path';
import { sha256hex } from './chunk.js';
import { appendEntries, loadManifest, saveManifestAtomic } from './manifest.js';
import type { ChunkEntry } from './manifest.js';
import { verifyChunk } from './verify.js';
//   the manifest entry is merged once via appendentries; never duplicated.
// hash reuse: sha256hex only, imported from chunk.js. verify via verifychunk.

export interface P2PHave {
  sha256: string;
  file: string;
  bytes: number;
}

export interface P2PWantItem {
  sha256: string;
  offset: number;
}

export interface P2PNodeOpts {
  outDir: string;
  port: number;
  blockBytes?: number;
  failAtBytes?: number;
}

export interface P2PSyncOpts {
  blockBytes?: number;
  timeoutMs?: number;
}

export interface P2PSyncResult {
  received: string[];
  skipped: string[];
  bytes: number;
  resumed: boolean;
}

type WireMsg =
  | { t: 'hello'; have: P2PHave[]; partials: P2PWantItem[] }
  | { t: 'welcome'; have: P2PHave[] }
  | { t: 'want'; items: P2PWantItem[] }
  | { t: 'meta'; entry: ChunkEntry; blocks: number; blockBytes: number }
  | { t: 'block'; sha256: string; offset: number; data: string }
  | { t: 'end'; sha256: string }
  | { t: 'ack'; sha256: string; ok: boolean }
  | { t: 'endbatch' }
  | { t: 'bye' }
  | { t: 'error'; message: string };

function ensureArchive(outDir: string): void {
  mkdirSync(join(outDir, 'warm'), { recursive: true });
  if (!existsSync(join(outDir, 'manifest.json'))) {
    saveManifestAtomic(outDir, { version: 1, createdAt: new Date(0).toISOString(), chunks: [], cold: [] });
  }
}

export function summaryOf(outDir: string): P2PHave[] {
  try {
    const { manifest } = loadManifest(outDir);
    return manifest.chunks
      .filter((e) => !e.quarantined)
      .map((e) => ({ sha256: e.sha256, file: e.file, bytes: e.bytes }));
  } catch {
    return [];
  }
}

function journalPath(outDir: string, sha256: string): string {
  return join(outDir, `.p2p-state-${sha256.slice(0, 12)}.json`);
}

function partPath(outDir: string, file: string): string {
  return join(outDir, 'warm', `${file}.part`);
}

function readJournalState(outDir: string, sha256: string): number | null {
  try {
    const j = JSON.parse(readFileSync(journalPath(outDir, sha256), 'utf8')) as { offset: number; sha256: string; file?: string };
    if (j.sha256 !== sha256 || !Number.isFinite(j.offset) || (j.offset as number) <= 0) return null;
    if (typeof j.file !== 'string' || j.file === '' || !existsSync(partPath(outDir, j.file))) return null;
    return Math.min(Math.floor(j.offset), statSync(partPath(outDir, j.file)).size) || null;
  } catch {
    return null;
  }
}

export function partialsOf(outDir: string): P2PWantItem[] {
  return listJournals(outDir);
}

function listJournals(outDir: string): P2PWantItem[] {
  let names: string[] = [];
  try {
    names = readdirSync(outDir);
  } catch {
    return [];
  }
  const out: P2PWantItem[] = [];
  for (const n of names) {
    if (!/^\.p2p-state-[0-9a-f]{12}\.json$/.test(n)) continue;
    try {
      const j = JSON.parse(readFileSync(join(outDir, n), 'utf8')) as { offset: number; sha256: string; file?: string };
      if (typeof j.sha256 !== 'string' || typeof j.file !== 'string' || j.file === '') continue;
      if (!existsSync(partPath(outDir, j.file))) continue;
      const off = Math.min(Math.floor(j.offset), statSync(partPath(outDir, j.file)).size);
      if (!(off > 0)) continue;
      out.push({ sha256: j.sha256, offset: off });
    } catch {
      /* torn journal: ignore */
    }
  }
  return out;
}


function entryBySha(outDir: string, sha256: string): { entry: ChunkEntry; data: Buffer } | null {
  let manifest;
  try {
    manifest = loadManifest(outDir).manifest;
  } catch {
    return null;
  }
  const entry = manifest.chunks.find((e) => e.sha256 === sha256 && !e.quarantined);
  if (!entry) return null;
  const full = join(outDir, 'warm', entry.file);
  try {
    return { entry, data: readFileSync(full) };
  } catch {
    return null;
  }
}

// idempotent apply of one fully received chunk. returns 'written' | 'skipped'.
function applyComplete(outDir: string, entry: ChunkEntry): 'written' | 'skipped' {
  const dest = join(outDir, 'warm', entry.file);
  const part = partPath(outDir, entry.file);
  const pick = existsSync(part) ? part : dest;
  let buf: Buffer;
  try {
    buf = readFileSync(pick);
  } catch {
    throw new Error(`missing received bytes for ${entry.file}`);
  }
  if (sha256hex(buf) !== entry.sha256) throw new Error(`post-transfer hash mismatch for ${entry.file}`);
  if (existsSync(dest)) {
    try {
      if (sha256hex(readFileSync(dest)) === entry.sha256) {
        // already applied: merge manifest entry once, drop part/journal.
        try {
          appendEntries(outDir, [entry]);
        } catch {
          /* manifest merge best-effort when bytes already good */
        }
        try {
          unlinkSync(part);
        } catch {
          /* no part */
        }
        try {
          unlinkSync(journalPath(outDir, entry.sha256));
        } catch {
          /* no journal */
        }
        const v = verifyChunk(dest);
        if (!v.ok) throw new Error(`verify failed for ${entry.file}: ${v.error ?? ''}`);
        return 'skipped';
      }
    } catch (e) {
      if ((e as Error).message.startsWith('verify failed')) throw e;
      /* unreadable dest: fall through to atomic install */
    }
  }
  const tmp = `${dest}.tmp.${process.pid}`;
  mkdirSync(join(outDir, 'warm'), { recursive: true });
  writeFileSync(tmp, buf);
  renameSync(tmp, dest);
  try {
    unlinkSync(part);
  } catch {
    /* part was dest itself */
  }
  try {
    unlinkSync(journalPath(outDir, entry.sha256));
  } catch {
    /* no journal */
  }
  const v = verifyChunk(dest);
  if (!v.ok) throw new Error(`verify failed for ${entry.file}: ${v.error ?? ''}`);
  appendEntries(outDir, [entry]);
  return 'written';
}

function storeBlock(outDir: string, entry: ChunkEntry, offset: number, data: Buffer): number {
  const part = partPath(outDir, entry.file);
  mkdirSync(join(outDir, 'warm'), { recursive: true });
  if (!existsSync(part)) {
    const fd = openSync(part, 'w');
    try {
      writeSync(fd, data, 0, data.length, 0);
    } finally {
      closeSync(fd);
    }
  } else {
    const pos = Math.min(offset, statSync(part).size);
    const fd = openSync(part, 'r+');
    try {
      writeSync(fd, data, 0, data.length, pos);
    } finally {
      closeSync(fd);
    }
  }
  let end = offset + data.length;
  try {
    end = statSync(part).size;
  } catch {
    /* keep computed end */
  }
  writeFileSync(journalPath(outDir, entry.sha256), JSON.stringify({ offset: end, sha256: entry.sha256, file: entry.file }));
  return end;
}

interface Conn {
  send: (msg: WireMsg) => void;
  close: () => void;
}

async function serveItems(outDir: string, conn: Conn, items: P2PWantItem[], blockBytes: number, failState: { armed: number | undefined }): Promise<void> {
  let sentBytes = 0;
  for (const item of items) {
    const hit = entryBySha(outDir, item.sha256);
    if (!hit) {
      conn.send({ t: 'error', message: `unknown chunk ${item.sha256.slice(0, 12)}` });
      continue;
    }
    const { entry, data } = hit;
    if (data.length === 0 || sha256hex(data) !== entry.sha256) {
      conn.send({ t: 'error', message: `local corrupt ${entry.file}` });
      continue;
    }
    const start = Math.min(Math.max(0, Math.floor(item.offset)), data.length);
    const blocks = Math.ceil((data.length - start) / blockBytes);
    conn.send({ t: 'meta', entry, blocks, blockBytes });
    for (let off = start; off < data.length; off += blockBytes) {
      const end = Math.min(off + blockBytes, data.length);
      conn.send({ t: 'block', sha256: entry.sha256, offset: off, data: data.subarray(off, end).toString('base64') });
      sentBytes += end - off;
      if (failState.armed !== undefined && sentBytes >= failState.armed) {
        failState.armed = undefined;
        // abrupt kill mid-transfer: no end/endbatch, receiver keeps partial+journal.
        conn.close();
        return;
      }
      // yield so a kill lands between blocks, not after the whole batch.
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    conn.send({ t: 'end', sha256: entry.sha256 });
  }
  conn.send({ t: 'endbatch' });
}

export function startNode(opts: P2PNodeOpts): { port: number; url: string; stop: () => void } {
  ensureArchive(opts.outDir);
  const outDir = opts.outDir;
  const blockBytes = opts.blockBytes ?? 16 * 1024;
  const failState: { armed: number | undefined } = { armed: opts.failAtBytes };
  const pendingAcks = new Map<string, { entry: ChunkEntry }>();
  const server = Bun.serve({
    port: opts.port,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response('molt p2p', { status: 426 });
    },
    websocket: {
      open() {
        /* hello drives */
      },
      async message(ws, raw) {
        const send = (msg: WireMsg) => {
          try {
            ws.send(JSON.stringify(msg));
          } catch {
            /* peer gone */
          }
        };
        let msg: WireMsg;
        try {
          msg = JSON.parse(String(raw)) as WireMsg;
        } catch {
          return;
        }
        const conn: Conn = { send, close: () => { try { ws.close(); } catch { /* gone */ } } };
        if (msg.t === 'hello') {
          const local = summaryOf(outDir);
          const localShas = new Set(local.map((h) => h.sha256));
          send({ t: 'welcome', have: local });
          // delta this node still needs from the dialer.
          const need: P2PWantItem[] = [];
          for (const h of msg.have) {
            if (!localShas.has(h.sha256) && !existsSync(join(outDir, 'warm', h.file))) need.push({ sha256: h.sha256, offset: 0 });
          }
          if (need.length > 0) send({ t: 'want', items: need });
          return;
        }
        if (msg.t === 'want') {
          await serveItems(outDir, conn, msg.items, blockBytes, failState);
          return;
        }
        if (msg.t === 'meta') {
          pendingAcks.set(msg.entry.sha256, { entry: msg.entry });
          // resume: drop stale bytes when the sender restarts at 0 for a new sha.
          return;
        }
        if (msg.t === 'block') {
          const rec = pendingAcks.get(msg.sha256);
          if (!rec) return;
          storeBlock(outDir, rec.entry, msg.offset, Buffer.from(msg.data, 'base64'));
          return;
        }
        if (msg.t === 'end') {
          const rec = pendingAcks.get(msg.sha256);
          if (!rec) return;
          pendingAcks.delete(msg.sha256);
          try {
            applyComplete(outDir, rec.entry);
            send({ t: 'ack', sha256: msg.sha256, ok: true });
          } catch (e) {
            send({ t: 'ack', sha256: msg.sha256, ok: false });
            send({ t: 'error', message: (e as Error).message });
          }
          return;
        }
        if (msg.t === 'bye') {
          try {
            ws.close();
          } catch {
            /* gone */
          }
        }
      },
    },
  });
  return { port: server.port, url: `ws://127.0.0.1:${server.port}/p2p`, stop: () => server.stop() };
}

export function syncFromPeer(peerUrl: string, outDir: string, opts: P2PSyncOpts = {}): Promise<P2PSyncResult> {
  ensureArchive(outDir);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise<P2PSyncResult>((resolve, reject) => {
    const received: string[] = [];
    const skipped: string[] = [];
    let bytes = 0;
    let resumed = false;
    let pendingIn = new Map<string, { entry: ChunkEntry; expected: number; got: number }>();
    let endbatch = false;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      done(() => reject(new Error('p2p sync timeout')));
      try {
        ws.close();
      } catch {
        /* gone */
      }
    }, timeoutMs);
    const ws = new WebSocket(peerUrl) as WebSocket & { close(): void };
    const send = (msg: WireMsg) => ws.send(JSON.stringify(msg));
    const maybeFinish = () => {
      if (endbatch && pendingIn.size === 0) {
        try {
          send({ t: 'bye' });
        } catch {
          /* closing anyway */
        }
        const result: P2PSyncResult = { received, skipped, bytes, resumed };
        done(() => resolve(result));
        try {
          ws.close();
        } catch {
          /* closed */
        }
      }
    };
    ws.onopen = () => {
      send({ t: 'hello', have: summaryOf(outDir), partials: listJournals(outDir) });
    };
    ws.onmessage = (ev) => {
      let msg: WireMsg;
      try {
        msg = JSON.parse(String(ev.data)) as WireMsg;
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        const local = new Set(summaryOf(outDir).map((h) => h.sha256));
        const journals = new Map(listJournals(outDir).map((j) => [j.sha256, j.offset]));
        if (journals.size > 0) resumed = true;
        const items: P2PWantItem[] = [];
        for (const h of msg.have) {
          if (local.has(h.sha256)) {
            skipped.push(h.file);
            continue;
          }
          // partial offset survives the kill; fresh chunks start at 0.
          items.push({ sha256: h.sha256, offset: journals.get(h.sha256) ?? 0 });
          if ((journals.get(h.sha256) ?? 0) > 0) resumed = true;
        }
        send({ t: 'want', items });
        return;
      }
      if (msg.t === 'want') {
        const conn: Conn = { send, close: () => ws.close() };
        void serveItems(outDir, conn, msg.items, opts.blockBytes ?? 16 * 1024, { armed: undefined });
        return;
      }
      if (msg.t === 'meta') {
        pendingIn.set(msg.entry.sha256, { entry: msg.entry, expected: msg.entry.bytes, got: 0 });
        return;
      }
      if (msg.t === 'block') {
        const rec = pendingIn.get(msg.sha256);
        if (!rec) return;
        const n = storeBlock(outDir, rec.entry, msg.offset, Buffer.from(msg.data, 'base64'));
        rec.got = n;
        bytes += Buffer.byteLength(msg.data, 'base64');
        return;
      }
      if (msg.t === 'end') {
        const rec = pendingIn.get(msg.sha256);
        if (!rec) return;
        pendingIn.delete(msg.sha256);
        try {
          const how = applyComplete(outDir, rec.entry);
          if (how === 'written') received.push(rec.entry.file);
          else skipped.push(rec.entry.file);
        } catch (e) {
          done(() => reject(e as Error));
          try {
            ws.close();
          } catch {
            /* gone */
          }
          return;
        }
        maybeFinish();
        return;
      }
      if (msg.t === 'ack') {
        return;
      }
      if (msg.t === 'endbatch') {
        endbatch = true;
        maybeFinish();
        return;
      }
      if (msg.t === 'error') {
        // non-fatal per-chunk errors are already acked; fatal ones reject only
        // when nothing can still complete.
        void msg.message;
        return;
      }
    };
    ws.onerror = () => {
      if (pendingIn.size > 0) done(() => reject(new Error('connection lost mid-transfer')));
    };
    ws.onclose = () => {
      if (settled) return;
      if (pendingIn.size > 0 || !endbatch) {
        done(() => reject(new Error('connection lost mid-transfer')));
        return;
      }
      const result: P2PSyncResult = { received, skipped, bytes, resumed };
      done(() => resolve(result));
    };
  });
}
