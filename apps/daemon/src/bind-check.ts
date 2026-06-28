import { createServer } from "node:net";

// Preflight bind-check (Flow-1 failure path). Before the daemon binds its UI
// listener it probes the target loopback port. When the port is already in use,
// it surfaces a typed, generic, user-readable startup error that NAMES the
// conflicting port plus a one-line fix — never a raw stack trace or a leaked
// `EADDRINUSE`.

const LOOPBACK = "127.0.0.1";

export interface StartupError {
  readonly fix: string;
  readonly kind: "port-busy";
  readonly message: string;
  readonly port: number;
}

export interface PreflightResult {
  readonly error?: StartupError;
  readonly ok: boolean;
}

const portBusy = (port: number): PreflightResult => ({
  ok: false,
  error: {
    kind: "port-busy",
    port,
    message: `Port ${port} is already in use.`,
    fix: "Free that port, or start the daemon with --port <other>.",
  },
});

export const preflightBindCheck = (
  port: number,
  host: string = LOOPBACK
): Promise<PreflightResult> =>
  new Promise<PreflightResult>((resolveResult) => {
    const probe = createServer();
    probe.once("error", () => {
      // Any bind failure is surfaced as the same generic, stack-free shape; the
      // raw Error (and its stack / EADDRINUSE) is deliberately never propagated.
      resolveResult(portBusy(port));
    });
    probe.listen(port, host, () => {
      probe.close(() => resolveResult({ ok: true }));
    });
  });
