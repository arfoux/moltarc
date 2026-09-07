// moltarc thumb — pure-js downscale previews (jpeg-js, no native build deps).
// A thumb is keyed by the full blob sha: foto/thumb-<fullSha>.jpg plus a
// foto/thumb-<fullSha>.json link {fullSha, thumbSha, width, height}, so a
// preview always resolves back to the exact full bytes it was made from.
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { decode, encode } from 'jpeg-js';
import { atomicWrite } from './guard.js';

export const THUMB_MAX_SIDE = 32;
export const THUMB_QUALITY = 70;
// Input cap: jpeg-js decode allocates w*h*4 up front, so an unbounded input
// is a memory bomb. 32MB still covers every real foto sidecar by ~60x.
export const THUMB_INPUT_MAX_BYTES = 32 * 1024 * 1024;
// Dimension cap enforced BEFORE decode by parsing the SOF header below.
// 8192px covers 48MP photos; anything larger throws instead of decoding.
export const THUMB_MAX_DIM = 8192;

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

// JPEG dimensions without decoding: walk markers to the first SOF frame
// header and read height/width. Null when the bytes are not a jpeg (the
// non-jpeg fallback path below) or the headers truncate mid-walk.
export function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1];
    if (marker === 0xd8 || marker === 0xd9) { off += 2; continue; } // SOI / EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; } // standalone
    const len = (buf[off + 2] << 8) | buf[off + 3];
    if (len < 2 || off + 2 + len > buf.length) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 7) return null;
      const height = (buf[off + 5] << 8) | buf[off + 6];
      const width = (buf[off + 7] << 8) | buf[off + 8];
      if (!width || !height) return null;
      return { width, height };
    }
    off += 2 + len;
  }
  return null;
}

// Downscale full jpeg bytes to a small preview; hash-links to the full blob.
export function makeThumb(full: Uint8Array, maxSide = THUMB_MAX_SIDE): Thumb {
  if (full.length > THUMB_INPUT_MAX_BYTES) {
    throw new Error(`thumb input ${full.length}B exceeds ${THUMB_INPUT_MAX_BYTES}B cap (refusing decode)`);
  }
  const src = Buffer.from(full);
  const fullSha = fullShaOf(src);
  const dim = jpegDimensions(src);
  if (dim && (dim.width > THUMB_MAX_DIM || dim.height > THUMB_MAX_DIM)) {
    throw new Error(`thumb dimensions ${dim.width}x${dim.height} exceed ${THUMB_MAX_DIM}px cap (refusing decode)`);
  }
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
// Both writes are atomic (tmp + fsync + rename + dir fsync via the shared
// guard): a crash keeps the old preview or nothing, never a torn jpg/meta.
export function saveThumb(outDir: string, full: Uint8Array): { path: string; metaPath: string; thumb: Thumb } {
  const thumb = makeThumb(full);
  mkdirSync(join(outDir, 'foto'), { recursive: true });
  const path = thumbFile(outDir, thumb.fullSha);
  const metaPath = thumbMetaFile(outDir, thumb.fullSha);
  if (!existsSync(path)) atomicWrite(path, thumb.data);
  const meta: ThumbMeta = { fullSha: thumb.fullSha, thumbSha: thumb.thumbSha, width: thumb.width, height: thumb.height };
  atomicWrite(metaPath, `${JSON.stringify(meta)}\n`);
  return { path, metaPath, thumb };
}

export function readThumb(outDir: string, fullSha: string): Buffer {
  return readFileSync(thumbFile(outDir, fullSha));
}

export function readThumbMeta(outDir: string, fullSha: string): ThumbMeta {
  return JSON.parse(readFileSync(thumbMetaFile(outDir, fullSha), 'utf8')) as ThumbMeta;
}
