import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { join } from 'path';
import { createHmac } from 'crypto';
import { sha256hex } from './chunk.js';
import { appendEntries, loadManifest, saveManifestAtomic } from './manifest.js';
import type { ChunkEntry } from './manifest.js';
import { verifyChunk } from './verify.js';
import { assertChunkName, assertSha } from './guard.js';

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
  /** aggregate bytes accepted per connection; excess drops the chunk and closes. */
  maxSessionBytes?: number;
  /** pre-shared key: when set, every wire message must carry a valid hmac or it is dropped. empty = lan only with a warning. */
  token?: string;
  /** sha256(token) strings allowed to pull from this node; empty = serve anyone (lan default). */
  allowPeers?: string[];
}
export interface P2PSyncOpts {
  blockBytes?: number;
  timeoutMs?: number;
  /** fetch-only: receive from the peer but ignore inbound want (serve nothing). */
  fetchOnly?: boolean;
  /** aggregate bytes accepted per sync run; excess rejects like an oversize chunk. */
  maxSessionBytes?: number;
  /** pre-shared key: signs every outbound message when talking to a guarded peer. */
  token?: string;
}

export interface P2PSyncResult {
  received: string[];
  skipped: string[];
  /** remote error messages and ack-false shas surfaced without failing the sync. */
  failed: string[];
  bytes: number;
  resumed: boolean;
}
type WireMsg =
  | { t: 'hello'; have: P2PHave[]; partials: P2PWantItem[]; auth?: string; token?: string }
  | { t: 'welcome'; have: P2PHave[]; auth?: string }
  | { t: 'want'; items: P2PWantItem[]; auth?: string }
  | { t: 'meta'; entry: ChunkEntry; blocks: number; blockBytes: number; auth?: string }
  | { t: 'block'; sha256: string; offset: number; data: string; auth?: string }
  | { t: 'end'; sha256: string; auth?: string }
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

/** Upper bound for any single chunk accepted off the wire. */
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
/** Default aggregate cap per connection / sync run against volume fill. */
export const MAX_SESSION_BYTES = 256 * 1024 * 1024;
/** Upper bound for have[] entries per hello: more is a memory bomb, not an archive. */
export const MAX_HAVE = 50000;
/** hmac over the message identity fields; empty token signs nothing (lan mode). */
export function wireAuth(token: string | undefined, parts: Array<string | number>): string {
  if (!token) return '';
  return createHmac('sha256', token).update(parts.join('|')).digest('hex');
}
/** peer allowlist holds sha256(token); empty list serves anyone (lan default). */
export function peerAllowed(allowPeers: string[] | undefined, token: string | undefined): boolean {
  if (!allowPeers || allowPeers.length === 0) return true;
  if (!token) return false;
  return allowPeers.includes(sha256hex(Buffer.from(token, 'utf8')));
}
/** Wire entries must name a real chunk file, carry a valid sha, and fit the cap. */
function validWireEntry(entry: ChunkEntry): boolean {
  try {
    if (!entry || typeof entry !== 'object') return false;
    assertChunkName(entry.file);
    assertSha(entry.sha256);
    if (!Number.isFinite(entry.bytes) || entry.bytes <= 0 || entry.bytes > MAX_CHUNK_BYTES) return false;
    return true;
  } catch {
    return false;
  }
}

/** Per-chunk receive cap: the entry's own byte count, 4MB when absent/invalid. */
function chunkCapFor(entry: ChunkEntry): number {
  return Number.isFinite(entry.bytes) && (entry.bytes as number) > 0
    ? Math.min(entry.bytes as number, MAX_CHUNK_BYTES)
    : MAX_CHUNK_BYTES;
}

function validHave(h: P2PHave): boolean {
  try {
    assertSha(h.sha256);
    assertChunkName(h.file);
    return true;
  } catch {
    return false;
  }
}

interface Conn {
  send: (msg: WireMsg) => void;
  close: () => void;
}

async function serveItems(outDir: string, conn: Conn, items: P2PWantItem[], blockBytes: number, failState: { armed: number | undefined }): Promise<void> {
  let sentBytes = 0;
  for (const item of items) {
    try {
      assertSha(item.sha256);
    } catch {
      conn.send({ t: 'error', message: `bad chunk request ${String(item?.sha256).slice(0, 12)}` });
      continue;
    }
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
  const pendingByConn = new WeakMap<object, Map<string, { entry: ChunkEntry }>>();
  const pendingFor = (ws: object): Map<string, { entry: ChunkEntry }> => {
    let m = pendingByConn.get(ws);
    if (!m) {
      m = new Map();
      pendingByConn.set(ws, m);
    }
    return m;
  };
  // Aggregate volume per connection against disk-fill by many valid chunks.
  const sessionUsedByConn = new WeakMap<object, { used: number }>();
  const maxSessionBytes = opts.maxSessionBytes ?? MAX_SESSION_BYTES;
  const sessionFor = (ws: object): { used: number } => {
    let st = sessionUsedByConn.get(ws);
    if (!st) {
      st = { used: 0 };
      sessionUsedByConn.set(ws, st);
    }
    return st;
  };
  // Tokens presented via hello, keyed per connection for the allowlist gate.
  const tokenByConn = new WeakMap<object, string>();
  const peerTokenOf = (ws: object): string | undefined => tokenByConn.get(ws);
  const blockBytes = opts.blockBytes ?? 16 * 1024;
  const failState: { armed: number | undefined } = { armed: opts.failAtBytes };
  let server: { port: number; stop(): void } | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      server = Bun.serve({
        port: opts.port,
    fetch(req: Request, server: { upgrade(req: Request): boolean }) {
      if (server.upgrade(req)) return;
      return new Response('molt p2p', { status: 426 });
    },
    websocket: {
      open() {
        /* hello drives */
      },
      close(ws: object) {
        pendingByConn.delete(ws);
      },
      async message(ws: { send(data: string): void; close(): void }, raw: unknown) {
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
        const pendingAcks = pendingFor(ws);
        if (msg.t === 'hello') {
          if (opts.token && msg.auth !== wireAuth(opts.token, ['hello', JSON.stringify(msg.have?.length ?? 0)])) { conn.close(); return; }
          tokenByConn.set(ws, typeof msg.token === 'string' ? msg.token : '');
          const local = summaryOf(outDir);
          const localShas = new Set(local.map((h) => h.sha256));
          send({ t: 'welcome', have: local, auth: wireAuth(opts.token, ['welcome', local.length]) });
          // delta this node still needs from the dialer.
          const need: P2PWantItem[] = [];
          const have = Array.isArray(msg.have) ? msg.have.slice(0, MAX_HAVE + 1) : [];
          if (msg.have.length > MAX_HAVE) { send({ t: 'error', message: 'have list too large' }); return; }
          for (const h of have) {
            if (!validHave(h)) continue;
            if (!localShas.has(h.sha256) && !existsSync(join(outDir, 'warm', h.file))) need.push({ sha256: h.sha256, offset: 0 });
          }
          if (need.length > 0) send({ t: 'want', items: need });
          return;
        }
        if (msg.t === 'want') {
          if (!peerAllowed(opts.allowPeers, peerTokenOf(ws))) { send({ t: 'error', message: 'not allowed' }); conn.close(); return; }
          const items = Array.isArray(msg.items) ? msg.items : [];
          await serveItems(outDir, conn, items, blockBytes, failState);
          return;
        }
        if (msg.t === 'meta') {
          if (!validWireEntry(msg.entry)) {
            send({ t: 'error', message: `bad entry ${String(msg.entry?.file ?? '?')}` });
            return;
          }
          pendingAcks.set(msg.entry.sha256, { entry: msg.entry });
          // resume: drop stale bytes when the sender restarts at 0 for a new sha.
          return;
        }
        if (msg.t === 'block') {
          try {
            assertSha(msg.sha256);
          } catch {
            return;
          }
          const rec = pendingAcks.get(msg.sha256);
          if (!rec) return;
          if (typeof msg.data !== 'string' || msg.data.length > blockBytes * 4 * 4 / 3 + 8) return;
          let buf: Buffer;
          try {
            buf = Buffer.from(msg.data, 'base64');
          } catch {
            return;
          }
          if (!Number.isFinite(msg.offset) || (msg.offset as number) < 0) return;
          if (buf.length > blockBytes * 4) {
            send({ t: 'error', message: `oversize block for ${rec.entry.file}` });
            pendingAcks.delete(msg.sha256);
            conn.close();
            return;
          }
          const got = (rec as { got?: number }).got ?? 0;
          if ((msg.offset as number) < got) { pendingAcks.delete(msg.sha256); return; }
          (rec as { got?: number }).got = (msg.offset as number) + buf.length;
          const end = storeBlock(outDir, rec.entry, msg.offset, buf);
          if (end > chunkCapFor(rec.entry)) {
            send({ t: 'error', message: `oversize chunk ${rec.entry.file}` });
            pendingAcks.delete(msg.sha256);
            conn.close();
          }
          const st = sessionFor(ws);
          st.used += buf.length;
          if (st.used > maxSessionBytes) {
            send({ t: 'error', message: `session cap exceeded` });
            pendingAcks.delete(msg.sha256);
            conn.close();
          }
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
      break;
    } catch (e) {
      const code = typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined;
      if (code !== 'EADDRINUSE' || attempt === 4) throw e;
    }
  }
  if (!server) throw new Error('p2p serve failed to bind after retries');
  const live: { port: number; stop(): void } = server;
  return { port: live.port, url: `ws://127.0.0.1:${live.port}/p2p`, stop: () => live.stop() };
}

export function syncFromPeer(peerUrl: string, outDir: string, opts: P2PSyncOpts = {}): Promise<P2PSyncResult> {
  ensureArchive(outDir);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const blockBytes = opts.blockBytes ?? 16 * 1024;
  return new Promise<P2PSyncResult>((resolve, reject) => {
    const received: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    let bytes = 0;
    const pendingIn = new Map<string, { entry: ChunkEntry; expected: number; got: number }>();
    let sessionUsed = 0;
    const maxSessionBytes = opts.maxSessionBytes ?? MAX_SESSION_BYTES;
    let resumed = false;
    let endbatch = false;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const onTimeout = () => {
      done(() => reject(new Error('p2p sync timeout')));
      try {
        ws.close();
      } catch {
        /* gone */
      }
    };
    let timer = setTimeout(onTimeout, timeoutMs);
    // Any wire progress pushes the deadline out; only a stalled peer times out.
    const poke = () => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(onTimeout, timeoutMs);
    };
    const ws = new WebSocket(peerUrl) as WebSocket & { close(): void };
    const send = (msg: WireMsg) => ws.send(JSON.stringify(msg));
    const maybeFinish = () => {
      if (endbatch && pendingIn.size === 0) {
        try {
          send({ t: 'bye' });
        } catch {
          /* closing anyway */
        }
        const result: P2PSyncResult = { received, skipped, failed, bytes, resumed };
        done(() => resolve(result));
        try {
          ws.close();
        } catch {
          /* closed */
        }
      }
    };
    ws.onopen = () => {
      const have = summaryOf(outDir);
      send({ t: 'hello', have, partials: listJournals(outDir), auth: wireAuth(opts.token, ['hello', JSON.stringify(have.length)]), token: opts.token });
    };
    ws.onmessage = (ev) => {
      let msg: WireMsg;
      try {
        msg = JSON.parse(String(ev.data)) as WireMsg;
      } catch {
        return;
      }
      poke();
      if (msg.t === 'welcome') {
        const local = new Set(summaryOf(outDir).map((h) => h.sha256));
        const journals = new Map(listJournals(outDir).map((j) => [j.sha256, j.offset]));
        if (journals.size > 0) resumed = true;
        const items: P2PWantItem[] = [];
        const have = Array.isArray(msg.have) ? msg.have : [];
        for (const h of have) {
          if (!validHave(h)) continue;
          if (local.has(h.sha256)) {
            skipped.push(h.file);
            continue;
          }
          // partial offset survives the kill; fresh chunks start at 0.
          items.push({ sha256: h.sha256, offset: journals.get(h.sha256) ?? 0 });
          if ((journals.get(h.sha256) ?? 0) > 0) resumed = true;
        }
        send({ t: 'want', items, auth: wireAuth(opts.token, ['want', items.length]) });
        return;
      }
      if (msg.t === 'want') {
        // Fetch-only mode serves nothing back: ignore inbound want.
        if (opts.fetchOnly) return;
        const conn: Conn = { send, close: () => ws.close() };
        const items = Array.isArray(msg.items) ? msg.items : [];
        void serveItems(outDir, conn, items, blockBytes, { armed: undefined });
        return;
      }
      if (msg.t === 'meta') {
        if (!validWireEntry(msg.entry)) {
          failed.push(String(msg.entry?.sha256 ?? 'bad-entry'));
          try {
            send({ t: 'error', message: `bad entry ${String(msg.entry?.file ?? '?')}` });
          } catch {
            /* closing anyway */
          }
          return;
        }
        pendingIn.set(msg.entry.sha256, { entry: msg.entry, expected: msg.entry.bytes, got: 0 });
        return;
      }
      if (msg.t === 'block') {
        const rec = pendingIn.get(msg.sha256);
        if (!rec) return;
        if (typeof msg.data !== 'string' || msg.data.length > blockBytes * 4 * 4 / 3 + 8) { pendingIn.delete(msg.sha256); failed.push(msg.sha256); done(() => reject(new Error(`oversize block for ${rec.entry.file} rejected`))); try { ws.close(); } catch { /* closing anyway */ } return; }
        let buf: Buffer;
        try {
          buf = Buffer.from(msg.data, 'base64');
        } catch {
          return;
        }
        if (!Number.isFinite(msg.offset) || (msg.offset as number) < 0) return;
        if ((msg.offset as number) < rec.got) { pendingIn.delete(msg.sha256); failed.push(msg.sha256); return; }
        if (buf.length > blockBytes * 4) {
          pendingIn.delete(msg.sha256);
          failed.push(msg.sha256);
          done(() => reject(new Error(`oversize block for ${rec.entry.file} rejected`)));
          try {
            ws.close();
          } catch {
            /* closing anyway */
          }
          return;
        }
        if ((msg.offset as number) + buf.length > chunkCapFor(rec.entry)) {
          pendingIn.delete(msg.sha256);
          failed.push(msg.sha256);
          done(() => reject(new Error(`oversize chunk ${rec.entry.file} rejected`)));
          try {
            ws.close();
          } catch {
            /* closing anyway */
          }
          return;
        }
        const n = storeBlock(outDir, rec.entry, msg.offset, buf);
        if (n > chunkCapFor(rec.entry)) {
          pendingIn.delete(msg.sha256);
          failed.push(msg.sha256);
          done(() => reject(new Error(`oversize chunk ${rec.entry.file} rejected`)));
          try {
            ws.close();
          } catch {
            /* closing anyway */
          }
          return;
        }
        sessionUsed += buf.length;
        if (sessionUsed > maxSessionBytes) {
          pendingIn.delete(msg.sha256);
          failed.push(msg.sha256);
          done(() => reject(new Error(`session cap exceeded`)));
          try {
            ws.close();
          } catch {
            /* closing anyway */
          }
          return;
        }
        rec.got = n;
        bytes += buf.length;
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
          failed.push(msg.sha256);
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
        if (!msg.ok) failed.push(msg.sha256);
        return;
      }
      if (msg.t === 'endbatch') {
        endbatch = true;
        maybeFinish();
        return;
      }
      if (msg.t === 'error') {
        // Non-fatal per-chunk errors are surfaced in failed[]; the batch still completes.
        failed.push(msg.message);
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
      const result: P2PSyncResult = { received, skipped, failed, bytes, resumed };
      done(() => resolve(result));
    };
  });
}
