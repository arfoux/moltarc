// p2p PSK rotation regressions: FAIL pre-fix (no key list, single-key-only
// verify rejects old-key peers), PASS post-fix. Bun-only, no full suite.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import {
  PSK_ENV,
  PSK_ID_ENV,
  authOk,
  frameWire,
  parsePsk,
  parsePskList,
  pskFromEnv,
  psksFromEnv,
  resolvePsk,
  resolvePsks,
  unframeWire,
  wireAuth,
} from '../src/p2p.js';

type Wire = Parameters<typeof frameWire>[1];

const freshHex = (): string => randomBytes(32).toString('hex');
const freshBuf = (): Buffer => randomBytes(32);

const helloSignedBy = (key: Buffer): Wire =>
  ({ t: 'hello', have: [], partials: [], auth: wireAuth(key, ['hello', 0]) }) as Wire;

describe('p2p PSK rotation', () => {
  it('resolvePsks returns the comma-separated list primary-first', { timeout: 30_000 }, () => {
    const newHex = freshHex();
    const oldHex = freshHex();
    const env = { [PSK_ENV]: `${newHex},${oldHex}` };
    const keys = resolvePsks(undefined, env);
    assert.ok(keys && keys.length === 2);
    assert.equal(keys[0].toString('hex'), newHex);
    assert.equal(keys[1].toString('hex'), oldHex);
    // explicit string wins over env, same order.
    const explicit = resolvePsks(`${newHex},${oldHex}`, { [PSK_ENV]: freshHex() });
    assert.ok(explicit && explicit.length === 2);
    assert.equal(explicit[0].toString('hex'), newHex);
    assert.equal(explicit[1].toString('hex'), oldHex);
  });

  it('single-key input keeps working exactly as before', { timeout: 30_000 }, () => {
    const hex = freshHex();
    assert.equal(resolvePsk(hex)?.toString('hex'), parsePsk(hex)?.toString('hex'));
    const list = resolvePsks(hex);
    assert.ok(list && list.length === 1);
    assert.equal(list[0].toString('hex'), hex);
    assert.equal(pskFromEnv({ [PSK_ENV]: hex })?.toString('hex'), hex);
    assert.equal(resolvePsk(undefined, { [PSK_ENV]: hex })?.toString('hex'), hex);
    // Buffer input round-trips as a one-element list.
    const buf = freshBuf();
    assert.equal(resolvePsks(buf)?.length, 1);
    assert.ok(resolvePsks(buf)?.[0].equals(buf));
  });

  it('old-key peer accepted during transition (frame + per-message auth)', { timeout: 30_000 }, () => {
    const newKey = freshBuf();
    const oldKey = freshBuf();
    const verifying = resolvePsks(`${newKey.toString('hex')},${oldKey.toString('hex')}`);
    assert.ok(verifying && verifying.length === 2);
    // Frame HMAC from the old key verifies against the list.
    const raw = frameWire(oldKey, helloSignedBy(oldKey));
    assert.equal(unframeWire(verifying, raw), raw.slice(raw.indexOf('.') + 1));
    // Per-message auth signed by the old key verifies against the list.
    assert.equal(authOk(verifying, helloSignedBy(oldKey)), true);
    // New-key traffic verifies too.
    assert.equal(authOk(verifying, helloSignedBy(newKey)), true);
  });

  it('wrong key rejected during transition (frame + per-message auth)', { timeout: 30_000 }, () => {
    const newKey = freshBuf();
    const oldKey = freshBuf();
    const wrongKey = freshBuf();
    const verifying = resolvePsks(`${newKey.toString('hex')},${oldKey.toString('hex')}`);
    assert.ok(verifying && verifying.length === 2);
    const raw = frameWire(wrongKey, helloSignedBy(wrongKey));
    assert.equal(unframeWire(verifying, raw), null);
    assert.equal(authOk(verifying, helloSignedBy(wrongKey)), false);
  });

  it('send path uses the primary: new-only peer accepts, old-only peer rejects', { timeout: 30_000 }, () => {
    const newKey = freshBuf();
    const oldKey = freshBuf();
    const keys = resolvePsks(`${newKey.toString('hex')},${oldKey.toString('hex')}`);
    assert.ok(keys && keys.length === 2);
    const primary = keys[0];
    assert.ok(primary.equals(newKey));
    const raw = frameWire(primary, helloSignedBy(primary));
    assert.notEqual(unframeWire([newKey], raw), null);
    assert.equal(unframeWire([oldKey], raw), null);
    assert.equal(authOk([newKey], helloSignedBy(primary)), true);
    assert.equal(authOk([oldKey], helloSignedBy(primary)), false);
  });

  it('documents the MOLTARC_PSK_ID transition contract', { timeout: 30_000 }, () => {
    assert.equal(PSK_ID_ENV, 'MOLTARC_PSK_ID');
    assert.equal(typeof parsePskList, 'function');
    assert.equal(typeof psksFromEnv, 'function');
    // Whitespace around entries is tolerated; empties are skipped.
    const hex = freshHex();
    const list = parsePskList(`  ${hex} , `);
    assert.ok(list && list.length === 1);
    assert.equal(list[0].toString('hex'), hex);
  });
});
