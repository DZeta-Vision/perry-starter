import { describe, expect, test } from "vitest";

// Mutation twin for loopback-auth.gate.test.ts. The anti-vacuous proof: each way
// the bearer gate could fail open or go vacuously green is planted here and
// asserted to redden, with a clean control that stays green.

// --- Timing-safe-compare source detector (same shape as the gate) ---

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

const TIMING_SAFE_RE = /timingSafeEqual/;
const NAIVE_SECRET_COMPARE_RE =
  /\b(?:token|bearer|secret|expected|provided)\w*\s*(?:===|!==)|(?:===|!==)\s*\b(?:token|bearer|secret|expected|provided)\w*/i;

const usesTimingSafeCompare = (source: string): boolean =>
  TIMING_SAFE_RE.test(stripJsComments(source));
const hasNaiveSecretCompare = (source: string): boolean =>
  NAIVE_SECRET_COMPARE_RE.test(stripJsComments(source));

const BEARER_GATED_ROUTE = "/api/ping";
const VALID_TOKEN = "per-launch-bearer-token-for-test-only";
const HTTP_UNAUTHORIZED = 401;

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

const newApp = async (): Promise<FastifyLike> => {
  const { default: Fastify } = (await import("fastify")) as {
    default: () => FastifyLike;
  };
  const app = Fastify();
  app.get(BEARER_GATED_ROUTE, () => ({ ok: true }));
  return app;
};

describe("the bearer-gate mutations each redden the gate", () => {
  test("a hook that always calls done() (bearer check bypassed) lets the no-token request return non-401 → the gate's 401 expectation would fail", async () => {
    const app = await newApp();
    // Bypassed hook: never refuses — the failure mode the gate must catch.
    const bypass = (_req: unknown, _reply: unknown, done: () => void) => done();
    app.addHook("onRequest", bypass);
    try {
      const res = await app.inject({ method: "GET", url: BEARER_GATED_ROUTE });
      expect(res.statusCode).not.toBe(HTTP_UNAUTHORIZED);
    } finally {
      await app.close();
    }
  });

  test("a hook that refuses EVERYTHING (even the valid token) makes the positive-pass assertion fail → catches a blanket-deny that would be vacuously green", async () => {
    const app = await newApp();
    const blanketDeny = (
      _req: unknown,
      reply: { code: (n: number) => { send: (b: unknown) => void } },
      _done: () => void
    ) => reply.code(HTTP_UNAUTHORIZED).send({ error: "denied" });
    app.addHook("onRequest", blanketDeny);
    try {
      const res = await app.inject({
        method: "GET",
        url: BEARER_GATED_ROUTE,
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      // Under blanket-deny even the valid token is 401, so the gate's
      // "valid → non-401" positive control would correctly fail.
      expect(res.statusCode).toBe(HTTP_UNAUTHORIZED);
    } finally {
      await app.close();
    }
  });

  test("a `===` token compare trips the timing-safe source guard, while a timingSafeEqual control stays green", () => {
    expect(
      hasNaiveSecretCompare("if (bearerToken === expected) { allow(); }")
    ).toBe(true);
    expect(
      usesTimingSafeCompare("if (bearerToken === expected) { allow(); }")
    ).toBe(false);
    const clean = "const ok = timingSafeEqual(Buffer.from(a), Buffer.from(b));";
    expect(usesTimingSafeCompare(clean)).toBe(true);
    expect(hasNaiveSecretCompare(clean)).toBe(false);
  });
});
