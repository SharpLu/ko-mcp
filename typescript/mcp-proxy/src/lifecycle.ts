/** Event-emitting subset of process / process.stdin used by the lifecycle wiring. */
export interface EventSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface LifecycleIO {
  /** Signal source (process). */
  proc: EventSource;
  /** stdin — EOF ("end"/"close") means the MCP client is gone. */
  stdin: EventSource;
  /** Exit function (process.exit), injectable for tests. */
  exit: (code: number) => void;
}

export interface LifecycleTarget {
  server: { onclose?: (() => void) | undefined };
  close(): Promise<void>;
}

/**
 * Wire every termination path to a single idempotent shutdown:
 * SIGINT/SIGTERM, stdin EOF, and server transport close all drain the proxy
 * then exit 0. A second signal while shutdown is in progress exits 130
 * immediately (standard interrupted-exit code).
 */
export function wireLifecycle(target: LifecycleTarget, io: LifecycleIO): { shutdown(): Promise<void> } {
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await target.close();
    } catch {
      // Best-effort drain; never block exit on a failing close.
    } finally {
      io.exit(0);
    }
  };

  const onSignal = (): void => {
    if (shuttingDown) {
      io.exit(130);
      return;
    }
    void shutdown();
  };

  io.proc.on("SIGINT", onSignal);
  io.proc.on("SIGTERM", onSignal);
  io.stdin.on("end", () => void shutdown());
  io.stdin.on("close", () => void shutdown());
  target.server.onclose = () => void shutdown();

  return { shutdown };
}
