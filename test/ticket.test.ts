// ticket single-spend voucher: offline double-use + sync reconcile report.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { issueTicket, TicketStore } from '../src/ticket.js';

describe('ticket', () => {
  it('redeems once, then detects offline double-use', { timeout: 30_000 }, () => {
    const s = new TicketStore();
    const v = s.issue(15000, 1_700_000_000_000, 'n1');
    assert.equal(s.redeem(v.id).ok, true);
    const again = s.redeem(v.id);
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'double-use');
    assert.equal(s.attemptsOf(v.id), 2);
  });

  it('rejects unknown ids and round-trips offline state', { timeout: 30_000 }, () => {
    const s = new TicketStore();
    assert.deepEqual(s.redeem('t-deadbeefcafe'), { ok: false, reason: 'unknown' });
    const v = s.issue(25000, 1_700_000_000_000, 'n2');
    s.redeem(v.id);
    const copy = TicketStore.fromJSON(s.toJSON());
    assert.equal(copy.isRedeemed(v.id), true);
    assert.equal(copy.redeem(v.id).reason, 'double-use');
  });

  it('reconcile splits clean / double-used / local-only / remote-only', { timeout: 30_000 }, () => {
    const s = new TicketStore();
    const a = s.issue(1000, 1, 'a');
    const b = s.issue(2000, 1, 'b');
    const c = s.issue(3000, 1, 'c');
    s.redeem(a.id);
    s.redeem(b.id);
    s.redeem(b.id); // double-use offline
    const rep = s.reconcile([a.id, 't-external0000']);
    assert.deepEqual(rep.clean, [a.id]);
    assert.deepEqual(rep.doubleUsed, [b.id]);
    assert.deepEqual(rep.localOnly, [b.id]);
    assert.deepEqual(rep.remoteOnly, ['t-external0000']);
    assert.ok(!rep.clean.includes(c.id), 'never-redeemed stays out');
  });

  it('issue is deterministic and validates input', { timeout: 30_000 }, () => {
    assert.equal(issueTicket(500, 9, 'x').id, issueTicket(500, 9, 'x').id);
    assert.throws(() => issueTicket(0), /> 0/);
    assert.throws(() => issueTicket(5, 1, ''), /nonce/);
  });

  it('ignores unknown ids in attempts and validates snapshots', { timeout: 30_000 }, () => {
    const s = new TicketStore();
    assert.deepEqual(s.redeem('t-deadbeefcafe'), { ok: false, reason: 'unknown' });
    assert.equal(s.attemptsOf('t-deadbeefcafe'), 0);
    assert.throws(
      () => TicketStore.fromJSON({ issued: [{ id: 'x', value: NaN, issuedAt: 1, nonce: 'n' }], redeemed: [], attempts: [] }),
      /invalid voucher/,
    );
    assert.throws(() => TicketStore.fromJSON({ issued: [], redeemed: 'nope' } as never), /arrays/);
  });
});
