import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Conformance gate — the daemon Origin/CSRF guard. A browser-driven request from
// a disallowed Origin or failing the CSRF check is rejected; Origin/CSRF is
// DOCUMENTED as defending browser-driven requests only — NOT a LAN control. The
// hook is driven on a real `fastify()` instance via `app.inject()`:
//   (a) state-changing request, Origin not on the loopback allow set → 403;
//   (b) same request with the allowed loopback Origin + Sec-Fetch-Site:
//       same-origin metadata → passes (anti-vacuous positive);
//   (c) state-changing request failing the CSRF check (Sec-Fetch-Site:
//       cross-site) → rejected.
// PLUS a docs-presence assertion that the module doc-comment states in words
// that Origin/CSRF defends browser-driven requests only and is NOT a LAN control.
//
// The mutation twin proves a removed hook and a deleted doc note redden.

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/daemon/src/conformance
const DAEMON_SRC = resolve(HERE, ".."); // apps/daemon/src
const SECURITY_FILE = resolve(DAEMON_SRC, "loopback-security.ts");

const ALLOWED_ORIGIN = "http://127.0.0.1:4317";
const DISALLOWED_ORIGIN = "https://evil.example.com";
const STATE_CHANGING_ROUTE = "/api/documents";
const HTTP_FORBIDDEN = 403;

// --- Docs-presence detector ("browser-only, NOT a LAN control") ---

const BROWSER_ONLY_RE = /browser[-\s]?(?:driven|only)/i;
const NOT_A_LAN_CONTROL_RE =
  /not\s+(?:a\s+|counted\s+as\s+a\s+)?lan\s+control/i;

const documentsBrowserOnlyNotLan = (source: string): boolean =>
  BROWSER_ONLY_RE.test(source) && NOT_A_LAN_CONTROL_RE.test(source);

interface FastifyLike {
  addHook: (event: string, hook: unknown) => void;
  close: () => Promise<void>;
  inject: (opts: {
    method: string;
    url: string;
    headers?: Record<string, string>;
  }) => Promise<{ statusCode: number }>;
  post: (path: string, handler: () => unknown) => void;
}

const mountOriginCsrfApp = async (): Promise<FastifyLike> => {
  const { default: Fastify } = (await import("fastify")) as {
    default: () => FastifyLike;
  };
  const { originCsrfHook } = (await import("../loopback-security")) as {
    originCsrfHook: (opts: { allowedOrigins: readonly string[] }) => unknown;
  };
  const app = Fastify();
  app.addHook(
    "preHandler",
    originCsrfHook({ allowedOrigins: [ALLOWED_ORIGIN] })
  );
  app.post(STATE_CHANGING_ROUTE, () => ({ ok: true }));
  return app;
};

describe("the daemon Origin/CSRF hook rejects disallowed-Origin and CSRF-failing browser requests", () => {
  test("a state-changing request from a disallowed Origin is rejected (403)", async () => {
    const app = await mountOriginCsrfApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: STATE_CHANGING_ROUTE,
        headers: {
          origin: DISALLOWED_ORIGIN,
          "sec-fetch-site": "cross-site",
        },
      });
      expect(res.statusCode).toBe(HTTP_FORBIDDEN);
    } finally {
      await app.close();
    }
  });

  test("the same request with the allowed loopback Origin + same-origin metadata passes (anti-vacuous positive)", async () => {
    const app = await mountOriginCsrfApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: STATE_CHANGING_ROUTE,
        headers: {
          origin: ALLOWED_ORIGIN,
          "sec-fetch-site": "same-origin",
        },
      });
      expect(res.statusCode).not.toBe(HTTP_FORBIDDEN);
    } finally {
      await app.close();
    }
  });

  test("a state-changing request failing the CSRF check (Sec-Fetch-Site: cross-site) is rejected", async () => {
    const app = await mountOriginCsrfApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: STATE_CHANGING_ROUTE,
        headers: {
          origin: ALLOWED_ORIGIN,
          "sec-fetch-site": "cross-site",
        },
      });
      expect(res.statusCode).toBe(HTTP_FORBIDDEN);
    } finally {
      await app.close();
    }
  });

  test("the security module documents Origin/CSRF as browser-only and NOT a LAN control", () => {
    const source = readFileSync(SECURITY_FILE, "utf8");
    expect(documentsBrowserOnlyNotLan(source)).toBe(true);
  });
});
