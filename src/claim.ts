// moltarc claim — single-spend permit: offline double-use detection via an
// exact used set, with a reconcile report on sync. hash primitives are
// import-only reuse.
// WARNING: ClaimStore is explicitly EPHEMERAL (in-memory only). A restart
// WITHOUT a toJSON snapshot + fromJSON restore LOSES usage history and
// spent claims become spendable again (double-spend). There is NO
// auto-persist: callers own durability. Snapshot after every use() in
// production; restore before serving. NOTE: claim ids are 12-hex
// (48-bit); kept for backward compatibility — do not rely on
// collision-resistance for adversarial issuance, use unique nonces.
import { sha256hex } from './chunk.js';

export interface Claim {
  id: string;
  value: number;
  issuedAt: number;
  nonce: string;
  /** absolute expiry (ms epoch). Absent = never expires (backward compatible). */
  expiresAt?: number;
}

export type UseReason = 'ok' | 'double-use' | 'unknown' | 'expired';

export interface UseResult {
  ok: boolean;
  reason: UseReason;
}

export interface ReconcileReport {
  doubleUsed: string[];
  localOnly: string[];
  remoteOnly: string[];
  clean: string[];
}

function randNonce(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return Buffer.from(bytes).toString('hex');
}

// Default claim lifetime (15 min). Rationale: claims are offline single-spend
// permits — a bounded window limits double-spend exposure from a lost snapshot
// restore, while 15 min comfortably covers issue→use→sync on foot patrol
// without forcing reissue. Shorter (1–5 min) would churn on slow links;
// longer (hours) keeps a stolen claim spendable all day.
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

// ttlMs resolution: argument OMITTED (3 args or fewer) → DEFAULT_TTL_MS;
// explicit undefined/null → never expires (backward compatible escape hatch
// for timeless permits); numeric → issuedAt + ttlMs. ttl never enters the id
// hash, so reissues stay deterministic.
export function issueClaim(value: number, issuedAt: number = Date.now(), nonce: string = randNonce(), ttlMs?: number | null): Claim {
  if (arguments.length < 4) ttlMs = DEFAULT_TTL_MS;
  if (!Number.isFinite(value) || value <= 0) throw new Error('issueClaim: value must be > 0');
  if (!Number.isFinite(issuedAt)) throw new Error('issueClaim: issuedAt must be finite');
  if (nonce === '') throw new Error('issueClaim: nonce must be non-empty');
  if (ttlMs !== undefined && ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs < 0)) throw new Error('issueClaim: ttlMs must be >= 0');
  const id = `t-${sha256hex(Buffer.from(`${value}:${issuedAt}:${nonce}`, 'utf8')).slice(0, 12)}`;
  const expiresAt = ttlMs === undefined || ttlMs === null ? undefined : issuedAt + ttlMs;
  return expiresAt === undefined ? { id, value, issuedAt, nonce } : { id, value, issuedAt, nonce, expiresAt };
}

// in-memory only: the used set lives in this process. callers MUST persist
// toJSON snapshots and restore via fromJSON, or a restart loses usage
// history and spent claims become spendable again.
export class ClaimStore {
  private issued = new Map<string, Claim>();
  private used = new Set<string>();
  private tries = new Map<string, number>();

  issue(value: number, issuedAt?: number, nonce?: string, ttlMs?: number | null): Claim {
    const v = arguments.length < 4
      ? issueClaim(value, issuedAt, nonce)
      : issueClaim(value, issuedAt, nonce, ttlMs);
    this.issued.set(v.id, v);
    return v;
  }

  load(v: Claim): void {
    this.issued.set(v.id, v);
  }

  has(id: string): boolean {
    return this.issued.has(id);
  }

  isUsed(id: string): boolean {
    return this.used.has(id);
  }

  // offline use: the exact used set decides, O(1) — no scan, no bloom
  // rebuild. unknown ids are rejected before any try is recorded, so
  // unissued ids never pollute the tries map. second use of the
  // same id reports double-use; unissued ids report unknown. claims past
  // expiresAt report expired and are never marked used (omitted ttlMs gets
  // DEFAULT_TTL_MS; explicit undefined/null stays never-expire).
  use(id: string): UseResult {
    const claim = this.issued.get(id);
    if (!claim) return { ok: false, reason: 'unknown' };
    if (claim.expiresAt !== undefined && Date.now() > claim.expiresAt) return { ok: false, reason: 'expired' };
    this.tries.set(id, (this.tries.get(id) ?? 0) + 1);
    if (this.used.has(id)) return { ok: false, reason: 'double-use' };
    this.used.add(id);
    return { ok: true, reason: 'ok' };
  }

  triesOf(id: string): number {
    return this.tries.get(id) ?? 0;
  }

  usedIds(): string[] {
    return [...this.used].sort();
  }

  // sync-time report: local used set vs server-used list. doubleUsed =
  // ids used more than once locally; localOnly needs push, remoteOnly
  // needs pull, clean = used exactly once and confirmed by the server.
  reconcile(remoteUsed: string[]): ReconcileReport {
    const remote = new Set(remoteUsed);
    const doubleUsed = [...this.used].filter((id) => (this.tries.get(id) ?? 0) > 1).sort();
    const doubleSet = new Set(doubleUsed);
    const localOnly = [...this.used].filter((id) => !remote.has(id)).sort();
    const remoteOnly = [...remote].filter((id) => !this.used.has(id)).sort();
    const clean = [...this.used].filter((id) => remote.has(id) && !doubleSet.has(id)).sort();
    return { doubleUsed, localOnly, remoteOnly, clean };
  }

  toJSON(): { issued: Claim[]; used: string[]; tries: [string, number][] } {
    return { issued: [...this.issued.values()], used: [...this.used], tries: [...this.tries.entries()] };
  }

  static fromJSON(snap: { issued: Claim[]; used: string[]; tries: [string, number][] }): ClaimStore {
    if (typeof snap !== 'object' || snap === null) throw new Error('ClaimStore.fromJSON: snapshot must be an object');
    if (!Array.isArray(snap.issued) || !Array.isArray(snap.used) || !Array.isArray(snap.tries)) {
      throw new Error('ClaimStore.fromJSON: snapshot needs issued/used/tries arrays');
    }
    const s = new ClaimStore();
    for (const v of snap.issued) {
      if (
        typeof v !== 'object' || v === null || typeof v.id !== 'string' || v.id === '' ||
        !Number.isFinite(v.value) || v.value <= 0 || !Number.isFinite(v.issuedAt) ||
        typeof v.nonce !== 'string' || v.nonce === '' ||
        (v.expiresAt !== undefined && !Number.isFinite(v.expiresAt))
      ) {
        throw new Error('ClaimStore.fromJSON: invalid claim');
      }
      s.issued.set(v.id, v.expiresAt === undefined
        ? { id: v.id, value: v.value, issuedAt: v.issuedAt, nonce: v.nonce }
        : { id: v.id, value: v.value, issuedAt: v.issuedAt, nonce: v.nonce, expiresAt: v.expiresAt });
    }
    for (const id of snap.used) {
      if (typeof id !== 'string' || id === '') throw new Error('ClaimStore.fromJSON: invalid used id');
      s.used.add(id);
    }
    for (const e of snap.tries) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || e[0] === '' || !Number.isInteger(e[1]) || e[1] < 0) {
        throw new Error('ClaimStore.fromJSON: invalid tries entry');
      }
      s.tries.set(e[0], e[1]);
    }
    return s;
  }
}
