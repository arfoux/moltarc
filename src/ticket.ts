// moltarc ticket — single-spend voucher: offline double-use detection via a
// local bloom pre-check plus an exact redeemed set for the verdict, with a
// reconcile report on sync. bloom/hash primitives are import-only reuse.
import { sha256hex } from './chunk.js';
import { buildBloom, bloomCheck } from './manifest.js';

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
  return Math.random().toString(36).slice(2, 10);
}

// deterministic id: same (value, issuedAt, nonce) reissues the same voucher.
export function issueTicket(value: number, issuedAt: number = Date.now(), nonce: string = randNonce()): Voucher {
  if (!Number.isFinite(value) || value <= 0) throw new Error('issueTicket: value must be > 0');
  if (!Number.isFinite(issuedAt)) throw new Error('issueTicket: issuedAt must be finite');
  if (nonce === '') throw new Error('issueTicket: nonce must be non-empty');
  const id = `t-${sha256hex(Buffer.from(`${value}:${issuedAt}:${nonce}`, 'utf8')).slice(0, 12)}`;
  return { id, value, issuedAt, nonce };
}

export class TicketStore {
  private issued = new Map<string, Voucher>();
  private redeemed = new Set<string>();
  private attempts = new Map<string, number>();
  private bloom = '';

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

  // offline redeem: bloom pre-check, exact set decides. second redeem of the
  // same id reports double-use; unissued ids report unknown.
  redeem(id: string): RedeemResult {
    this.attempts.set(id, (this.attempts.get(id) ?? 0) + 1);
    if (!this.issued.has(id)) return { ok: false, reason: 'unknown' };
    if (this.redeemed.has(id) || (this.bloom !== '' && bloomCheck(this.bloom, id) && this.redeemed.has(id))) {
      return { ok: false, reason: 'double-use' };
    }
    this.redeemed.add(id);
    this.bloom = buildBloom([...this.redeemed]);
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
    const s = new TicketStore();
    for (const v of snap.issued) s.issued.set(v.id, v);
    for (const id of snap.redeemed) s.redeemed.add(id);
    for (const [id, n] of snap.attempts) s.attempts.set(id, n);
    if (s.redeemed.size > 0) s.bloom = buildBloom([...s.redeemed]);
    return s;
  }
}
