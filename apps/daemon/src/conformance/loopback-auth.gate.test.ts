import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Conformance gate — the daemon loopback bearer guard. A request with no/invalid
// bearer is refused; the proof is the COMPENSATING control, never the listener
// bind. Loopback is NOT a security boundary, so the bind itself is an OS-level
// operator mitigation and is NOT asserted here (asserting it would be vacuously
// green). What is gated is the bearer check.
//
// The bearer-auth hook from `loopback-security.ts` is mounted on a real
// `fastify()` instance and driven via `app.inject()` (in-process injection, no
// listener or compiled binary required). A source detector additionally proves
// the token compare is timing-safe (`timingSafeEqual`), never `===`/`!==` on the
// secret.
//
// The mutation twin proves a bypassed hook, a blanket-deny hook, and a `===`
// compare each redden.

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/daemon/src/conformance
const DAEMON_SRC = resolve(HERE, ".."); // apps/daemon/src
const SECURITY_FILE = resolve(DAEMON_SRC, "loopback-security.ts");

const VALID_TOKEN = "per-launch-bearer-token-for-test-only";
const BEARER_GATED_ROUTE = "/api/ping";
const HTTP_UNAUTHORIZED = 401;

// --- Timing-safe-compare source detector (comment-resistant) ---

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

const TIMING_SAFE_RE = /timingSafeEqual/;
// A naive equality on a secret-shaped identifier is the forbidden side-channel.
const NAIVE_SECRET_COMPARE_RE =
  /\b(?:token|bearer|secret|expected|provided)\w*\s*(?:===|!==)|(?:===|!==)\s*\b(?:token|bearer|secret|expected|provided)\w*/i;

const usesTimingSafeCompare = (source: string): boolean =>
  TIMING_SAFE_RE.test(stripJsComments(source));
const hasNaiveSecretCompare = (source: string): boolean =>
  NAIVE_SECRET_COMPARE_RE.test(stripJsComments(source));

interface FastifyLike {
  addHook: (event: string, hook: unknown) => void;
  close: () => Promise<void>;
  get: (path: string, handler: () => unknown) => void;
  inject: (opts: {
    method: string;
    url: string;
    headers?: Record<string, string>;
  }) => Promise<{ statusCode: number }>;
}

// Build a fastify host with the real bearer-auth hook mounted on a gated route.
const mountGatedApp = async (token: string): Promise<FastifyLike> => {
  const { default: Fastify } = (await import("fastify")) as {
    default: () => FastifyLike;
  };
  const { bearerAuthHook } = (await import("../loopback-security")) as {
    bearerAuthHook: (t: string) => unknown;
  };
  const app = Fastify();
  app.addHook("onRequest", bearerAuthHook(token));
  app.get(BEARER_GATED_ROUTE, () => ({ ok: true }));
  return app;
};

describe("the daemon loopback bearer gate refuses an unauthenticated request (compensating control, never the bind)", () => {
  test("a request with NO Authorization header is refused with 401", async () => {
    const app = await mountGatedApp(VALID_TOKEN);
    try {
      const res = await app.inject({ method: "GET", url: BEARER_GATED_ROUTE });
      expect(res.statusCode).toBe(HTTP_UNAUTHORIZED);
    } finally {
      await app.close();
    }
  });

  test("a request with an INVALID bearer token is refused with 401", async () => {
    const app = await mountGatedApp(VALID_TOKEN);
    try {
      const res = await app.inject({
        method: "GET",
        url: BEARER_GATED_ROUTE,
        headers: { authorization: "Bearer the-wrong-token" },
      });
      expect(res.statusCode).toBe(HTTP_UNAUTHORIZED);
    } finally {
      await app.close();
    }
  });

  test("a request with the VALID per-launch bearer passes the guard (non-401) — the anti-vacuous positive", async () => {
    // Load-bearing: proves the 401s come from the bearer check, not a blanket
    // deny. Without it the gate would be vacuously green.
    const app = await mountGatedApp(VALID_TOKEN);
    try {
      const res = await app.inject({
        method: "GET",
        url: BEARER_GATED_ROUTE,
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(res.statusCode).not.toBe(HTTP_UNAUTHORIZED);
    } finally {
      await app.close();
    }
  });

  test("the bearer compare is timing-safe (crypto.subtle.timingSafeEqual), never === on the secret", () => {
    const source = readFileSync(SECURITY_FILE, "utf8");
    expect(usesTimingSafeCompare(source)).toBe(true);
    expect(hasNaiveSecretCompare(source)).toBe(false);
  });
});
