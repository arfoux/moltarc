// fork-CAS regression: identical sha bytes store once, refcounted across forks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { readdirSync } from 'fs';
import { join } from 'path';
import { casGet, casGc, casHas, casLink, casOwners, casPut, casRefcount, casUnlink } from '../src/cas.js';
import { scratch } from './util.js';

describe('fork cas', () => {
  it('identical bytes store once and round-trip', { timeout: 30_000 }, () => {
    const root = join(scratch('cas-once'), 'cas');
    const bytes = randomBytes(4096);
    const a = casPut(root, bytes);
    const b = casPut(root, bytes);
    assert.equal(a, b);
    assert.equal(readdirSync(join(root, 'objects')).length, 1);
    assert.ok(casHas(root, a));
    assert.ok(casGet(root, a).equals(bytes));
  });

  it('refcounts across two forks, gc frees only at zero', { timeout: 30_000 }, () => {
    const root = join(scratch('cas-fork'), 'cas');
    const sha = casPut(root, randomBytes(2048));
    casLink(root, sha, 'fork-a');
    casLink(root, sha, 'fork-a'); // idempotent: same owner links once
    casLink(root, sha, 'fork-b');
    assert.equal(casRefcount(root, sha), 2);
    assert.deepEqual(casOwners(root, sha), ['fork-a', 'fork-b']);
    casUnlink(root, sha, 'fork-a');
    assert.equal(casRefcount(root, sha), 1);
    assert.ok(casHas(root, sha), 'fork-b still holds a ref');
    assert.deepEqual(casGc(root), [], 'referenced bytes never collected');
    casUnlink(root, sha, 'fork-b');
    assert.deepEqual(casGc(root), [sha]);
    assert.ok(!casHas(root, sha));
    assert.throws(() => casGet(root, sha));
  });

  it('rejects bad sha, missing objects, and empty owners', { timeout: 30_000 }, () => {
    const root = join(scratch('cas-bad'), 'cas');
    const sha = casPut(root, Buffer.from('x'));
    assert.throws(() => casHas(root, 'nope'));
    assert.throws(() => casGet(root, '0'.repeat(64)), /ENOENT|no such file/i);
    assert.throws(() => casLink(root, '0'.repeat(64), 'fork-a'), /missing object/);
    assert.throws(() => casLink(root, sha, ''), /empty owner/);
    casUnlink(root, sha, 'ghost'); // idempotent: never linked, no throw
    assert.equal(casRefcount(root, sha), 0);
  });
});
