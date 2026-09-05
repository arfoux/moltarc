// moltarc readonly auditor mode — read-only handle over an archive dir.
// Wrapper only: reads delegate to find/verify/gc; every mutating op throws.
// Never imports seal/ship/cold write paths, so a write can only fail loud.
import { findTrx } from './find.js';
import type { FindResult } from './find.js';
import { verifyAll, verifyFull } from './verify.js';
import type { VerifyFullResult, VerifyResult } from './verify.js';
import { statusInfo } from './gc.js';
import type { StatusInfo } from './gc.js';

export const READONLY_HINT = 'archive opened read-only';

function refused(op: string, dir: string): Error {
  return new Error(`readonly: ${op} refused on ${dir} (${READONLY_HINT})`);
}

export interface ReadOnlyArchive {
  readonly dir: string;
  find(trxId: string): FindResult;
  verify(): VerifyResult;
  verifyFull(): VerifyFullResult;
  status(relayDir?: string): StatusInfo;
  // Mutating ops below always throw; args accepted so callers fail at
  // runtime with a clear read-only error instead of a type error.
  seal(...args: unknown[]): never;
  ship(...args: unknown[]): never;
  forget(...args: unknown[]): never;
  sweep(...args: unknown[]): never;
  sweepCold(...args: unknown[]): never;
  repair(...args: unknown[]): never;
  repairByHash(...args: unknown[]): never;
  quarantine(...args: unknown[]): never;
  merge(...args: unknown[]): never;
}

export function openArchiveReadOnly(dir: string): ReadOnlyArchive {
  const ro: ReadOnlyArchive = {
    dir,
    find: (trxId: string): FindResult => findTrx({ outDir: dir, trxId }),
    verify: (): VerifyResult => verifyAll(dir),
    verifyFull: (): VerifyFullResult => verifyFull(dir),
    status: (relayDir?: string): StatusInfo => statusInfo(dir, relayDir),
    seal: (..._args: unknown[]): never => { throw refused('seal', dir); },
    ship: (..._args: unknown[]): never => { throw refused('ship', dir); },
    forget: (..._args: unknown[]): never => { throw refused('forget', dir); },
    sweep: (..._args: unknown[]): never => { throw refused('sweep', dir); },
    sweepCold: (..._args: unknown[]): never => { throw refused('sweepCold', dir); },
    repair: (..._args: unknown[]): never => { throw refused('repair', dir); },
    repairByHash: (..._args: unknown[]): never => { throw refused('repairByHash', dir); },
    quarantine: (..._args: unknown[]): never => { throw refused('quarantine', dir); },
    merge: (..._args: unknown[]): never => { throw refused('merge', dir); },
  };
  return Object.freeze(ro);
}
