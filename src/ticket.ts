// moltarc ticket — single-spend voucher: offline double-use detection via an
// exact redeemed set, with a reconcile report on sync. hash primitives are
// import-only reuse.
import { sha256hex } from './chunk.js';

export interface Voucher {
  id: string;
  value: number;
  issuedAt: number;
  nonce: string;
}

export type RedeemReason = 'ok' | 'double-use' | 'unknown';

export interface RedeemResult {
  ok: boolean;
  reason: RedeemReason;
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

// deterministic id: same (value, issuedAt, nonce) reissues the same voucher.
export function issueTicket(value: number, issuedAt: number = Date.now(), nonce: string = randNonce()): Voucher {
  if (!Number.isFinite(value) || value <= 0) throw new Error('issueTicket: value must be > 0');
  if (!Number.isFinite(issuedAt)) throw new Error('issueTicket: issuedAt must be finite');
  if (nonce === '') throw new Error('issueTicket: nonce must be non-empty');
  const id = `t-${sha256hex(Buffer.from(`${value}:${issuedAt}:${nonce}`, 'utf8')).slice(0, 12)}`;
  return { id, value, issuedAt, nonce };
}

// in-memory only: the redeemed set lives in this process. callers MUST persist
// toJSON snapshots and restore via fromJSON, or a restart loses redemption
// history and spent vouchers become spendable again.
export class TicketStore {
  private issued = new Map<string, Voucher>();
  private redeemed = new Set<string>();
  private attempts = new Map<string, number>();

  issue(value: number, issuedAt?: number, nonce?: string): Voucher {
    const v = issueTicket(value, issuedAt, nonce);
    this.issued.set(v.id, v);
    return v;
  }

  load(v: Voucher): void {
    this.issued.set(v.id, v);
  }

  has(id: string): boolean {
    return this.issued.has(id);
  }

  isRedeemed(id: string): boolean {
    return this.redeemed.has(id);
  }

  // offline redeem: the exact redeemed set decides, O(1) — no scan, no bloom
  // rebuild. unknown ids are rejected before any attempt is recorded, so
  // unissued ids never pollute the attempts map. second redeem of the
  // same id reports double-use; unissued ids report unknown.
  redeem(id: string): RedeemResult {
    if (!this.issued.has(id)) return { ok: false, reason: 'unknown' };
    this.attempts.set(id, (this.attempts.get(id) ?? 0) + 1);
    if (this.redeemed.has(id)) return { ok: false, reason: 'double-use' };
    this.redeemed.add(id);
    return { ok: true, reason: 'ok' };
  }

  attemptsOf(id: string): number {
    return this.attempts.get(id) ?? 0;
  }

  redeemedIds(): string[] {
    return [...this.redeemed].sort();
  }

  // sync-time report: local redeemed set vs server-used list. doubleUsed =
  // ids redeemed more than once locally; localOnly needs push, remoteOnly
  // needs pull, clean = redeemed exactly once and confirmed by the server.
  reconcile(remoteUsed: string[]): ReconcileReport {
    const remote = new Set(remoteUsed);
    const doubleUsed = [...this.redeemed].filter((id) => (this.attempts.get(id) ?? 0) > 1).sort();
    const doubleSet = new Set(doubleUsed);
    const localOnly = [...this.redeemed].filter((id) => !remote.has(id)).sort();
    const remoteOnly = [...remote].filter((id) => !this.redeemed.has(id)).sort();
    const clean = [...this.redeemed].filter((id) => remote.has(id) && !doubleSet.has(id)).sort();
    return { doubleUsed, localOnly, remoteOnly, clean };
  }

  toJSON(): { issued: Voucher[]; redeemed: string[]; attempts: [string, number][] } {
    return { issued: [...this.issued.values()], redeemed: [...this.redeemed], attempts: [...this.attempts.entries()] };
  }

  static fromJSON(snap: { issued: Voucher[]; redeemed: string[]; attempts: [string, number][] }): TicketStore {
    if (typeof snap !== 'object' || snap === null) throw new Error('TicketStore.fromJSON: snapshot must be an object');
    if (!Array.isArray(snap.issued) || !Array.isArray(snap.redeemed) || !Array.isArray(snap.attempts)) {
      throw new Error('TicketStore.fromJSON: snapshot needs issued/redeemed/attempts arrays');
    }
    const s = new TicketStore();
    for (const v of snap.issued) {
      if (
        typeof v !== 'object' || v === null || typeof v.id !== 'string' || v.id === '' ||
        !Number.isFinite(v.value) || v.value <= 0 || !Number.isFinite(v.issuedAt) ||
        typeof v.nonce !== 'string' || v.nonce === ''
      ) {
        throw new Error('TicketStore.fromJSON: invalid voucher');
      }
      s.issued.set(v.id, { id: v.id, value: v.value, issuedAt: v.issuedAt, nonce: v.nonce });
    }
    for (const id of snap.redeemed) {
      if (typeof id !== 'string' || id === '') throw new Error('TicketStore.fromJSON: invalid redeemed id');
      s.redeemed.add(id);
    }
    for (const e of snap.attempts) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || e[0] === '' || !Number.isInteger(e[1]) || e[1] < 0) {
        throw new Error('TicketStore.fromJSON: invalid attempts entry');
      }
      s.attempts.set(e[0], e[1]);
    }
    return s;
  }
}
