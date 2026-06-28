import { describe, expect, test } from "vitest";

// Mutation twin for origin-csrf.gate.test.ts. Proves the two regressions redden:
// removing the Origin/CSRF hook lets a disallowed Origin through, and deleting
// the "browser-only, not a LAN control" doc note trips the docs-presence gate.

const ALLOWED_ORIGIN = "http://127.0.0.1:4317";
const DISALLOWED_ORIGIN = "https://evil.example.com";
const STATE_CHANGING_ROUTE = "/api/documents";
const HTTP_FORBIDDEN = 403;

// --- Docs-presence detector (same shape as the gate) ---

const BROWSER_ONLY_RE = /browser[-\s]?(?:driven|only)/i;
const NOT_A_LAN_CONTROL_RE =
  /not\s+(?:a\s+|counted\s+as\s+a\s+)?lan\s+control/i;
const documentsBrowserOnlyNotLan = (source: string): boolean =>
  BROWSER_ONLY_RE.test(source) && NOT_A_LAN_CONTROL_RE.test(source);

interface FastifyLike {
  close: () => Promise<void>;
  inject: (opts: {
    method: string;
    url: string;
    headers?: Record<string, string>;
  }) => Promise<{ statusCode: number }>;
  post: (path: string, handler: () => unknown) => void;
}

describe("removing the Origin/CSRF hook lets a disallowed Origin through", () => {
  test("with NO Origin/CSRF hook mounted, a disallowed-Origin state-changing request is NOT rejected → the gate's 403 expectation would fail", async () => {
    const { default: Fastify } = (await import("fastify")) as {
      default: () => FastifyLike;
    };
    const app = Fastify();
    // No originCsrfHook mounted — the failure mode the gate must catch.
    app.post(STATE_CHANGING_ROUTE, () => ({ ok: true }));
    try {
      const res = await app.inject({
        method: "POST",
        url: STATE_CHANGING_ROUTE,
        headers: { origin: DISALLOWED_ORIGIN, "sec-fetch-site": "cross-site" },
      });
      expect(res.statusCode).not.toBe(HTTP_FORBIDDEN);
    } finally {
      await app.close();
    }
  });
});

describe("deleting the browser-only doc note trips the docs-presence gate", () => {
  test("source missing the 'browser-only, not a LAN control' note reddens", () => {
    const withoutNote =
      "// The Origin/CSRF hook validates the request Origin against the allow set.";
    expect(documentsBrowserOnlyNotLan(withoutNote)).toBe(false);
  });

  test("source carrying the note stays green (not always-red)", () => {
    const withNote =
      "// Origin/CSRF defends browser-driven requests only; it is NOT a LAN control. " +
      ALLOWED_ORIGIN;
    expect(documentsBrowserOnlyNotLan(withNote)).toBe(true);
  });
});
