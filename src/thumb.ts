// moltarc thumb — pure-js downscale previews (jpeg-js, no native build deps).
// A thumb is keyed by the full blob sha: foto/thumb-<fullSha>.jpg plus a
// foto/thumb-<fullSha>.json link {fullSha, thumbSha, width, height}, so a
// preview always resolves back to the exact full bytes it was made from.
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { decode, encode } from 'jpeg-js';

export const THUMB_MAX_SIDE = 32;
export const THUMB_QUALITY = 70;

export interface Thumb {
  data: Buffer;
  width: number;
  height: number;
  fullSha: string;
  thumbSha: string;
}

export interface ThumbMeta {
  fullSha: string;
  thumbSha: string;
  width: number;
  height: number;
}

export function fullShaOf(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function thumbFile(outDir: string, fullSha: string): string {
  return join(outDir, 'foto', `thumb-${fullSha}.jpg`);
}

export function thumbMetaFile(outDir: string, fullSha: string): string {
  return join(outDir, 'foto', `thumb-${fullSha}.json`);
}

// Box-average downscale of RGBA pixels to fit inside maxSide (keeps aspect).
function downscaleBox(px: Buffer, w: number, h: number, maxSide: number): { data: Buffer; width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const out = Buffer.alloc(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor((y * h) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / th));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor((x * w) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / tw));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * w + sx) * 4;
          r += px[o];
          g += px[o + 1];
          b += px[o + 2];
          n++;
        }
      }
      const o = (y * tw + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 0xff;
    }
  }
  return { data: out, width: tw, height: th };
}

// Non-jpeg fallback: tile the raw bytes as gray pixels so arbitrary quarantined
// bodies still get a deterministic preview instead of throwing the seal gate.
function fallbackPixels(raw: Uint8Array, maxSide: number): { data: Buffer; width: number; height: number } {
  const w = maxSide;
  const h = maxSide;
  const out = Buffer.alloc(w * h * 4);
  const n = Math.max(1, raw.length);
  for (let i = 0; i < w * h; i++) {
    const v = raw[i % n] ?? 0;
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 0xff;
  }
  return { data: out, width: w, height: h };
}

// Downscale full jpeg bytes to a small preview; hash-links to the full blob.
export function makeThumb(full: Uint8Array, maxSide = THUMB_MAX_SIDE): Thumb {
  const src = Buffer.from(full);
  const fullSha = fullShaOf(src);
  let px: { data: Buffer; width: number; height: number };
  try {
    const img = decode(src);
    px = downscaleBox(Buffer.from(img.data), img.width, img.height, maxSide);
  } catch {
    px = fallbackPixels(src, maxSide);
  }
  const data = Buffer.from(encode({ data: px.data, width: px.width, height: px.height }, THUMB_QUALITY).data);
  return { data, width: px.width, height: px.height, fullSha, thumbSha: fullShaOf(data) };
}

// Write thumb jpg + hash-link meta under <outDir>/foto (idempotent per fullSha).
export function saveThumb(outDir: string, full: Uint8Array): { path: string; metaPath: string; thumb: Thumb } {
  const thumb = makeThumb(full);
  mkdirSync(join(outDir, 'foto'), { recursive: true });
  const path = thumbFile(outDir, thumb.fullSha);
  const metaPath = thumbMetaFile(outDir, thumb.fullSha);
  if (!existsSync(path)) writeFileSync(path, thumb.data);
  const meta: ThumbMeta = { fullSha: thumb.fullSha, thumbSha: thumb.thumbSha, width: thumb.width, height: thumb.height };
  const tmp = `${metaPath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(meta)}\n`);
  renameSync(tmp, metaPath);
  return { path, metaPath, thumb };
}

export function readThumb(outDir: string, fullSha: string): Buffer {
  return readFileSync(thumbFile(outDir, fullSha));
}

export function readThumbMeta(outDir: string, fullSha: string): ThumbMeta {
  return JSON.parse(readFileSync(thumbMetaFile(outDir, fullSha), 'utf8')) as ThumbMeta;
}
