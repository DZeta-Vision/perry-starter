// When the loopback port is already in use, the preflight bind-check surfaces a
// typed, generic, user-readable startup error that NAMES the conflicting port
// plus a one-line fix — never a raw stack trace or a leaked EADDRINUSE. The busy
// port is created in-test by binding an ephemeral socket. Paired twin:
// bind-check.mutation.test.ts.

import { createServer } from "node:net";
import { describe, expect, test } from "vitest";

const LOOPBACK = "127.0.0.1";
// A stack frame like `at Server.setupListenHandle (node:net:1234:56)`.
const STACK_FRAME_RE = /\bat\s+.+:\d+:\d+/;
const ONE_LINE_FIX_RE =
  /(?:free|stop|already in use|use (?:a )?different|--port|choose another|change the port)/i;

interface StartupError {
  readonly fix: string;
  readonly kind: string;
  readonly message: string;
  readonly port: number;
}
interface PreflightResult {
  readonly error?: StartupError;
  readonly ok: boolean;
}

const dyn = (specifier: string): Promise<Record<string, unknown>> =>
  import(specifier) as Promise<Record<string, unknown>>;

// Bind an ephemeral loopback port, returning the port + a release handle.
const occupyEphemeralPort = (): Promise<{
  port: number;
  release: () => void;
}> =>
  new Promise((resolveBind, rejectBind) => {
    const server = createServer();
    server.once("error", rejectBind);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolveBind({ port: address.port, release: () => server.close() });
      } else {
        rejectBind(new Error("failed to acquire an ephemeral port"));
      }
    });
  });

describe("the preflight bind-check surfaces a generic, port-naming, stack-free startup error", () => {
  test("a busy loopback port yields a typed error that names the port + a one-line fix and leaks no stack trace", async () => {
    const { port, release } = await occupyEphemeralPort();
    try {
      const mod = await dyn("./bind-check");
      const preflightBindCheck = mod.preflightBindCheck as (
        p: number,
        host?: string
      ) => Promise<PreflightResult>;

      const result = await preflightBindCheck(port, LOOPBACK);

      // (a) typed startup-error shape — not a thrown raw Error/EADDRINUSE.
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("port-busy");
      expect(result.error).not.toBeInstanceOf(Error);

      const surfaced = `${result.error?.message ?? ""}\n${result.error?.fix ?? ""}`;
      // (b) names the conflicting port.
      expect(surfaced).toContain(String(port));
      // (c) carries a one-line remediation.
      expect(surfaced).toMatch(ONE_LINE_FIX_RE);
      // (d) no stack-trace markers.
      expect(surfaced).not.toMatch(STACK_FRAME_RE);
      expect(surfaced).not.toContain("EADDRINUSE");
    } finally {
      release();
    }
  });
});
