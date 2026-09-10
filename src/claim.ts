// moltarc claim — single-spend permit: offline double-use detection via an
// exact used set, with a reconcile report on sync. hash primitives are
// import-only reuse.
import { sha256hex } from './chunk.js';

export interface Claim {
  id: string;
  value: number;
  issuedAt: number;
  nonce: string;
}

export type UseReason = 'ok' | 'double-use' | 'unknown';

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

// deterministic id: same (value, issuedAt, nonce) reissues the same claim.
export function issueClaim(value: number, issuedAt: number = Date.now(), nonce: string = randNonce()): Claim {
  if (!Number.isFinite(value) || value <= 0) throw new Error('issueClaim: value must be > 0');
  if (!Number.isFinite(issuedAt)) throw new Error('issueClaim: issuedAt must be finite');
  if (nonce === '') throw new Error('issueClaim: nonce must be non-empty');
  const id = `t-${sha256hex(Buffer.from(`${value}:${issuedAt}:${nonce}`, 'utf8')).slice(0, 12)}`;
  return { id, value, issuedAt, nonce };
}

// in-memory only: the used set lives in this process. callers MUST persist
// toJSON snapshots and restore via fromJSON, or a restart loses usage
// history and spent claims become spendable again.
export class ClaimStore {
  private issued = new Map<string, Claim>();
  private used = new Set<string>();
  private tries = new Map<string, number>();

  issue(value: number, issuedAt?: number, nonce?: string): Claim {
    const v = issueClaim(value, issuedAt, nonce);
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
  // same id reports double-use; unissued ids report unknown.
  use(id: string): UseResult {
    if (!this.issued.has(id)) return { ok: false, reason: 'unknown' };
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
        typeof v.nonce !== 'string' || v.nonce === ''
      ) {
        throw new Error('ClaimStore.fromJSON: invalid claim');
      }
      s.issued.set(v.id, { id: v.id, value: v.value, issuedAt: v.issuedAt, nonce: v.nonce });
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
