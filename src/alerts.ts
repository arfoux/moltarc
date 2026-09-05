// moltarc alerts — unacked-escalation report. read-only: no seal/ship/sweep writes.
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
}

const D_WARN_UNACKED = 5;
const D_CRIT_UNACKED = 20;
const D_WARN_QUAR = 1;
const D_CRIT_QUAR = 3;

function num(v: number | undefined, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

export function checkUnacked(outDir: string, relayDir: string, thresholds: AlertThresholds = {}): UnackedAlert {
  const warnUnacked = num(thresholds.warnUnacked, D_WARN_UNACKED);
  const critUnacked = num(thresholds.critUnacked, D_CRIT_UNACKED);
  const warnQuar = num(thresholds.warnQuarantined, D_WARN_QUAR);
  const critQuar = num(thresholds.critQuarantined, D_CRIT_QUAR);
  const warnFree = num(thresholds.warnFreeBytes, RESERVE_BYTES * 2);
  const critFree = num(thresholds.critFreeBytes, RESERVE_BYTES);

  let unacked = 0;
  let quarantined = 0;
  try {
    unacked = statusInfo(outDir, relayDir).unacked;
  } catch {
    unacked = 0;
  }
  try {
    quarantined = loadManifest(outDir).manifest.chunks.filter((e) => e.quarantined).length;
  } catch {
    quarantined = 0;
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
  return { level, unacked, quarantined, freeBytes: avail, reasons };
}
