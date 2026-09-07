// Minimal ambient types for the Bun-only runtime surface used by moltarc.
// Under node/tsc the global Bun object does not exist, so these structural
// declarations keep typechecking green; Bun provides the real implementation.
interface BunServer {
  port: number;
  stop(): void;
  upgrade(req: Request): boolean;
}
interface BunWs {
  send(data: string | Buffer | Uint8Array): void;
  close(): void;
}
interface BunServeOptions {
  port?: number;
  fetch?(req: Request, server: BunServer): Response | void | Promise<Response | void>;
  websocket?: {
    open?(ws: BunWs): void;
    close?(ws: BunWs): void;
    message?(ws: BunWs, raw: string | Buffer | ArrayBuffer | Uint8Array): void | Promise<void>;
  };
}
interface BunSpawned {
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
}
declare const Bun: {
  serve(opts: BunServeOptions): BunServer;
  spawn(
    cmd: string[],
    opts?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdout?: 'pipe' | 'inherit' | 'ignore' | null;
      stderr?: 'pipe' | 'inherit' | 'ignore' | null;
    },
  ): BunSpawned;
  sleep(ms: number): Promise<void>;
  readonly version: string;
};
