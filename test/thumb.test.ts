// thumb regression: pure-js downscale previews, hash-linked to the full blob.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'crypto';
import { encode } from 'jpeg-js';
import { makeJpeg } from '../bench/photo-bench.js';
import { THUMB_MAX_SIDE, makeThumb, readThumb, readThumbMeta, saveThumb } from '../src/thumb.js';
import { scratch } from './util.js';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('thumb pipeline', () => {
  it('downscales a real jpeg with hash link to full bytes', { timeout: 30_000 }, () => {
    const full = makeJpeg(7);
    const t = makeThumb(full);
    assert.equal(t.fullSha, sha(full));
    assert.equal(t.thumbSha, sha(t.data));
    assert.ok(t.width <= THUMB_MAX_SIDE && t.height <= THUMB_MAX_SIDE, `${t.width}x${t.height}`);
    assert.equal(t.data.subarray(0, 2).toString('hex'), 'ffd8', 'jpeg container');
    assert.ok(t.data.length < full.length, `thumb ${t.data.length}b < full ${full.length}b`);
    assert.equal(makeThumb(full).thumbSha, t.thumbSha, 'deterministic');
  });

  it('falls back to a deterministic preview for non-jpeg bytes', { timeout: 30_000 }, () => {
    const raw = randomBytes(1024);
    const a = makeThumb(raw);
    const b = makeThumb(raw);
    assert.equal(a.thumbSha, b.thumbSha);
    assert.ok(a.width <= THUMB_MAX_SIDE && a.height <= THUMB_MAX_SIDE);
    assert.equal(a.data.subarray(0, 2).toString('hex'), 'ffd8');
  });

  it('save/read round-trips jpg plus hash-link meta', { timeout: 30_000 }, () => {
    const dir = scratch('thumb-save');
    const full = makeJpeg(21);
    const { path, thumb } = saveThumb(dir, full);
    assert.ok(readThumb(dir, thumb.fullSha).equals(thumb.data), 'jpg bit-exact');
    const meta = readThumbMeta(dir, thumb.fullSha);
    assert.equal(meta.fullSha, thumb.fullSha);
    assert.equal(meta.thumbSha, sha(thumb.data), 'meta links thumb bytes');
    assert.equal(meta.width, thumb.width);
    // Idempotent re-save: same bytes, same path.
    const again = saveThumb(dir, full);
    assert.equal(again.path, path);
    assert.ok(readThumb(dir, thumb.fullSha).equals(thumb.data));
  });

  it('shrinks a gate-sized jpeg to a small preview', { timeout: 60_000 }, () => {
    // 512x512 white noise at q90: ~490KB, deterministically past the 256KB gate.
    let s = 99;
    const rnd = (): number => {
      s |= 0; s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const w = 512;
    const h = 512;
    const px = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      px[i * 4] = Math.floor(rnd() * 256);
      px[i * 4 + 1] = Math.floor(rnd() * 256);
      px[i * 4 + 2] = Math.floor(rnd() * 256);
      px[i * 4 + 3] = 0xff;
    }
    const full = Buffer.from(encode({ data: px, width: w, height: h }, 90).data);
    assert.ok(full.length > 256 * 1024, `full ${full.length}b trips the gate`);
    const t = makeThumb(full);
    assert.ok(t.width <= THUMB_MAX_SIDE && t.height <= THUMB_MAX_SIDE);
    assert.ok(t.data.length < 32 * 1024, `thumb ${t.data.length}b stays small`);
  });
});
