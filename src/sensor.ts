// moltarc sensor — lossy log for numeric series: downsample + anomaly flag +
// quarantine-cold routing. pure in-memory math; chunk/manifest primitives are
// import-only reuse (hash + bloom + chunk bridge), never a second copy.
import { encodeChunk, decodeChunk, sha256hex } from './chunk.js';
import type { HotRow } from './chunk.js';
import { buildBloom, bloomCheck } from './manifest.js';

export interface SensorPoint {
  ts: number;
  value: number;
  id: string;
}

export interface SensorBucket {
  t0: number;
  t1: number;
  count: number;
  min: number;
  max: number;
  sum: number;
  avg: number;
  first: number;
  last: number;
  anomalous: boolean;
}

export interface RouteResult {
  hot: SensorPoint[];
  cold: SensorPoint[];
  quarantined: SensorPoint[];
}

export interface FlagOpts {
  window?: number;
  z?: number;
}

export interface RouteOpts {
  coldBefore?: number;
  anomalyToCold?: boolean;
}

// fixed bucket lossy log: per-bucket min/max/avg/first/last. sorted by ts,
// one pass. bucketMs must be finite > 0; empty input yields []. optional
// flags (per-input-order, same length as points) marks a bucket anomalous
// when any of its points is flagged; omitted flags leave anomalous false.
export function downsample(points: SensorPoint[], bucketMs: number, flags?: boolean[]): SensorBucket[] {
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) throw new Error('downsample: bucketMs must be > 0');
  if (flags !== undefined && flags.length !== points.length) throw new Error('downsample: flags length mismatch');
  if (points.length === 0) return [];
  const order = points.map((_, i) => i).sort((a, b) => points[a].ts - points[b].ts);
  const out: SensorBucket[] = [];
  let cur: SensorBucket | null = null;
  for (const i of order) {
    const p = points[i];
    if (!Number.isFinite(p.ts) || !Number.isFinite(p.value)) throw new Error('downsample: non-finite ts/value');
    const t0 = Math.floor(p.ts / bucketMs) * bucketMs;
    if (cur === null || cur.t0 !== t0) {
      if (cur !== null) {
        cur.avg = cur.sum / cur.count;
        out.push(cur);
      }
      cur = { t0, t1: t0 + bucketMs, count: 0, min: p.value, max: p.value, sum: 0, avg: 0, first: p.value, last: p.value, anomalous: false };
    }
    cur.count += 1;
    if (p.value < cur.min) cur.min = p.value;
    if (p.value > cur.max) cur.max = p.value;
    cur.sum += p.value;
    cur.last = p.value;
    if (flags?.[i]) cur.anomalous = true;
  }
  if (cur !== null) {
    cur.avg = cur.sum / cur.count;
    out.push(cur);
  }
  return out;
}

// rolling z-score over up to `window` preceding points (ts order). the first
// minBaseline points never flag (no baseline yet). constant baseline
// (std 0) flags any deviation. returns per-input-order booleans.
//
// two-pass: pass 1 scores every point against all preceding points; pass 2
// re-scores against preceding points that were NOT flagged, so one huge
// spike cannot inflate the baseline variance enough to mask the next spike
// (baseline poisoning). flagged points never contribute to any baseline.
export function flagAnomalies(points: SensorPoint[], opts: FlagOpts = {}): boolean[] {
  const window = opts.window ?? 10;
  const z = opts.z ?? 3;
  if (!Number.isInteger(window) || window < 1) throw new Error('flagAnomalies: window must be int >= 1');
  if (!Number.isFinite(z) || z <= 0) throw new Error('flagAnomalies: z must be > 0');
  const order = points.map((_, i) => i).sort((a, b) => points[a].ts - points[b].ts);
  const minBaseline = Math.min(3, window);
  const score = (base: number[], v: number): boolean => {
    const mean = base.reduce((a, b) => a + b, 0) / base.length;
    const variance = base.reduce((a, b) => a + (b - mean) * (b - mean), 0) / base.length;
    const std = Math.sqrt(variance);
    return std === 0 ? v !== mean : Math.abs(v - mean) > z * std;
  };
  // pass 1: provisional flags against the raw preceding window (poisonable).
  const provisional = new Array<boolean>(points.length).fill(false);
  const seen: number[] = [];
  for (const idx of order) {
    const base = seen.slice(-window).map((i) => points[i].value);
    if (base.length >= minBaseline) provisional[idx] = score(base, points[idx].value);
    seen.push(idx);
  }
  // pass 2: final flags against the cleaned preceding window; a point joins
  // the baseline only when neither pass flagged it.
  const flags = new Array<boolean>(points.length).fill(false);
  const clean: number[] = [];
  for (const idx of order) {
    const base = clean.slice(-window).map((i) => points[i].value);
    if (base.length >= minBaseline) flags[idx] = score(base, points[idx].value);
    if (!provisional[idx] && !flags[idx]) clean.push(idx);
  }
  return flags;
}

// hot keeps fresh normal points; cold takes stale (ts < coldBefore) plus
// flagged anomalies when anomalyToCold (default true). quarantined mirrors
// the anomalous subset of cold for the cold-relay path.
//
// hot-anomaly note: with anomalyToCold: false, flagged fresh points stay hot
// and are NOT quarantined — quarantined mirrors only anomalies already routed
// to cold. callers that need every anomaly quarantined must keep
// anomalyToCold true (default) or collect flagged hot points separately.
export function routeQuarantine(points: SensorPoint[], flags: boolean[], opts: RouteOpts = {}): RouteResult {
  if (flags.length !== points.length) throw new Error('routeQuarantine: flags length mismatch');
  const coldBefore = opts.coldBefore ?? Number.NEGATIVE_INFINITY;
  const anomalyToCold = opts.anomalyToCold ?? true;
  const hot: SensorPoint[] = [];
  const cold: SensorPoint[] = [];
  const quarantined: SensorPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const stale = points[i].ts < coldBefore;
    const bad = anomalyToCold && flags[i];
    if (stale || bad) {
      cold.push(points[i]);
      if (flags[i]) quarantined.push(points[i]);
    } else {
      hot.push(points[i]);
    }
  }
  return { hot, cold, quarantined };
}

// bloom over anomalous ids for the cold-relay fetch path (reuse, not copy).
export function anomalyBloom(points: SensorPoint[], flags: boolean[]): string {
  const ids = points.filter((_, i) => flags[i]).map((p) => p.id);
  return buildBloom(ids);
}

export function anomalyBloomCheck(bloomB64: string, id: string): boolean {
  return bloomCheck(bloomB64, id);
}

// bridge downsampled buckets into the chunk codec: one HotRow per bucket,
// body carries the lossy summary; decode round-trips via decodeChunk.
export function bucketsToRows(buckets: SensorBucket[], table = 'sensor', device = 'sensor-01'): HotRow[] {
  return buckets.map((b, i) => ({
    device_id: device,
    seq: i + 1,
    ts: b.t0,
    id: `sensor-${b.t0}`,
    table,
    body: JSON.stringify({ t0: b.t0, count: b.count, min: b.min, max: b.max, avg: b.avg, first: b.first, last: b.last, anomalous: b.anomalous }),
  }));
}

export function packSensor(table: string, rows: HotRow[]): Buffer {
  return encodeChunk(table, rows);
}

export function unpackSensor(buf: Buffer): { headerRows: number; rows: HotRow[] } {
  const { header, rows } = decodeChunk(buf);
  return { headerRows: header.rows, rows };
}

// unambiguous encoding: each point is a JSON tuple, so ids containing ':'
// or newlines cannot collide with or forge another point's fields.
export function seriesHash(points: SensorPoint[]): string {
  return sha256hex(Buffer.from(points.map((p) => JSON.stringify([p.ts, p.value, p.id])).join('\n'), 'utf8'));
}
