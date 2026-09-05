// bundle atomic 1-text+N-refs pack with hash links.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { packBundle, verifyBundle, loadBundleManifest, readBundleRef } from '../src/bundle.js';
import { scratch } from './util.js';

describe('bundle', () => {
  it('packs one text plus refs and verifies clean', { timeout: 30_000 }, () => {
    const dir = scratch('bundle-ok');
    const m = packBundle(dir, 'qurban POD-7: 3 sapi, 7 kambing', [
      { name: 'sapi.txt', data: Buffer.from('sapi 3 ekor') },
      { name: 'kambing.txt', data: Buffer.from('kambing 7 ekor') },
    ]);
    assert.equal(m.refs.length, 2);
    assert.equal(m.text, 'qurban POD-7: 3 sapi, 7 kambing');
    const v = verifyBundle(dir);
    assert.deepEqual(v, { ok: true, errors: [] });
    const loaded = loadBundleManifest(dir);
    assert.equal(readBundleRef(dir, loaded.refs[0]).length, loaded.refs[0].bytes);
  });

  it('detects tampered ref bytes and missing manifest', { timeout: 30_000 }, () => {
    const dir = scratch('bundle-tamper');
    packBundle(dir, 'teks', [{ name: 'a.txt', data: Buffer.from('asli') }]);
    const m = loadBundleManifest(dir);
    writeFileSync(join(dir, 'refs', m.refs[0].sha256), Buffer.from('palsu!'));
    const v = verifyBundle(dir);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('a.txt')));
    assert.deepEqual(verifyBundle(scratch('bundle-empty')).ok, false);
  });

  it('rejects duplicate names, bad names, and empty data', { timeout: 30_000 }, () => {
    const dir = scratch('bundle-bad');
    assert.throws(() => packBundle(dir, 't', [
      { name: 'a.txt', data: Buffer.from('x') },
      { name: 'a.txt', data: Buffer.from('y') },
    ]), /duplicate/);
    assert.throws(() => packBundle(dir, 't', [{ name: '../evil', data: Buffer.from('x') }]), /bad ref name/);
    assert.throws(() => packBundle(dir, 't', [{ name: 'e.txt', data: Buffer.alloc(0) }]), /empty/);
  });
});
