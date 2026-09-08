// moltarc alerts — unacked-escalation report. read-only: no seal/ship/sweep writes.
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadManifest } from './manifest.js';
import { freeSpaceBytes, RESERVE_BYTES, statusInfo } from './gc.js';

export type AlertLevel = 'ok' | 'warn' | 'critical';

export interface AlertThresholds {
  warnUnacked?: number;
  critUnacked?: number;
  warnQuarantined?: number;
  critQuarantined?: number;
  warnFreeBytes?: number;
  critFreeBytes?: number;
  freeBytes?: number; // test seam: overrides statfs reading
}

export interface UnackedAlert {
  level: AlertLevel;
  unacked: number;
  quarantined: number;
  freeBytes: number;
  reasons: string[];
  /** dimensions that could not be read; counts for them are zero, not measured. */
  unknown: string[];
}

const D_WARN_UNACKED = 5;
const D_CRIT_UNACKED = 20;
const D_WARN_QUAR = 1;
const D_CRIT_QUAR = 3;

function num(v: number | undefined, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
// Missing/corrupt-archive gate: loadManifest() rebuilds from filenames when
// both copies are unreadable, so a fresh or torn dir would otherwise report
// ok with zero counts — unmeasured, not healthy. A copy counts as readable
// when it parses with a version and a chunks array (the structural half of
// the manifest copy check); anything less throws instead of reporting.
function hasReadableManifest(outDir: string): boolean {
  for (const f of ['manifest.json', 'manifest.bak.json']) {
    try {
      const m = JSON.parse(readFileSync(join(outDir, f), 'utf8')) as { version?: unknown; chunks?: unknown };
      if (m && typeof m === 'object' && typeof m.version === 'number' && Array.isArray(m.chunks)) return true;
    } catch { /* try next copy */ }
  }
  return false;
}

export function checkUnacked(outDir: string, relayDir: string, thresholds: AlertThresholds = {}): UnackedAlert {
  const warnUnacked = num(thresholds.warnUnacked, D_WARN_UNACKED);
  const critUnacked = num(thresholds.critUnacked, D_CRIT_UNACKED);
  const warnQuar = num(thresholds.warnQuarantined, D_WARN_QUAR);
  const critQuar = num(thresholds.critQuarantined, D_CRIT_QUAR);
  const warnFree = num(thresholds.warnFreeBytes, RESERVE_BYTES * 2);
  const critFree = num(thresholds.critFreeBytes, RESERVE_BYTES);
  if (!hasReadableManifest(outDir)) {
    throw new Error(`alerts: no readable manifest copy in ${outDir} (missing or corrupt archive)`);
  }
  let unacked = 0;
  let quarantined = 0;
  const unknown: string[] = [];
  try {
    unacked = statusInfo(outDir, relayDir).unacked;
  } catch {
    unknown.push('status unreadable: unacked unknown');
  }
  try {
    quarantined = loadManifest(outDir).manifest.chunks.filter((e) => e.quarantined).length;
  } catch {
    unknown.push('manifest unreadable: quarantined unknown');
  }
  const override = thresholds.freeBytes;
  const avail = typeof override === "number" && Number.isFinite(override) ? override : freeSpaceBytes(outDir);

  let level: AlertLevel = 'ok';
  const reasons: string[] = [];
  const escalate = (l: AlertLevel, reason: string): void => {
    reasons.push(reason);
    if (l === 'critical') level = 'critical';
    else if (l === 'warn' && level === 'ok') level = 'warn';
  };

  if (unacked >= critUnacked) escalate('critical', `unacked ${unacked} >= critical ${critUnacked}`);
  else if (unacked >= warnUnacked) escalate('warn', `unacked ${unacked} >= warn ${warnUnacked}`);

  if (quarantined >= critQuar) escalate('critical', `quarantined ${quarantined} >= critical ${critQuar}`);
  else if (quarantined >= warnQuar) escalate('warn', `quarantined ${quarantined} >= warn ${warnQuar}`);
  if (avail <= critFree) escalate("critical", `free ${avail} <= critical ${critFree}`);
  else if (avail <= warnFree) escalate("warn", `free ${avail} <= warn ${warnFree}`);
  for (const u of unknown) escalate('warn', u);
  return { level, unacked, quarantined, freeBytes: avail, reasons, unknown };
}
