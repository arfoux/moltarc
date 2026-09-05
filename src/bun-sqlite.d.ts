// Minimal ambient types for the bun-only sqlite driver.
// Static import is impossible: bun:sqlite does not exist under node/tsc,
// so src/seal.ts reaches it through a dynamic import (platform-module exception).
declare module 'bun:sqlite' {
  export interface BunQuery<T = unknown> {
    all(...params: unknown[]): T[];
    get(...params: unknown[]): T | null;
    run(...params: unknown[]): void;
  }
  export class Database {
    constructor(path: string, options?: { readonly?: boolean; create?: boolean });
    query<T = unknown>(sql: string): BunQuery<T>;
    run(sql: string, ...params: unknown[]): void;
    close(): void;
  }
}
