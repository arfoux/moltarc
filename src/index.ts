// molt v0.1 — archive skeleton. Worker owns full implementation.
// Contract: seal/ship/find per README. Never delete unsealed/unacked data.
export interface SealOpts {
  hotDb: string;
  outDir: string;
}
export async function seal(_opts: SealOpts): Promise<void> {
  throw new Error('not implemented — worker task');
}
export async function ship(_manifest: string, _relay: string): Promise<void> {
  throw new Error('not implemented — worker task');
}
export async function find(_manifest: string, _trxId: string): Promise<unknown> {
  throw new Error('not implemented — worker task');
}
