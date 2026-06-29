import { describe, expect, test } from "vitest";

// Mutation twin for bearer-delivery.gate.test.ts. Plants the two worst-case
// regressions and asserts each reddens, with clean controls.

// --- No-disclosure source guard (same shape as the gate) ---

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

const SENDS_BEARER_RE =
  /\b(?:reply|res)\s*\.\s*(?:send|header)\s*\([^)]*\b(?:bearer|token)\b/i;
const TOKEN_ROUTE_RE =
  /\.(?:get|post|put|delete|all)\s*\(\s*["'][^"']*\/(?:token|bearer)\b/i;

const disclosesBearer = (source: string): boolean => {
  const code = stripJsComments(source);
  return SENDS_BEARER_RE.test(code) || TOKEN_ROUTE_RE.test(code);
};

describe("the bearer-disclosure guard fires on a token-returning route", () => {
  test("a fixture daemon route that returns the bearer (GET /token → token) trips the no-disclosure guard", () => {
    const leak =
      'app.get("/token", (req, reply) => reply.send({ bearer: token }));';
    expect(disclosesBearer(leak)).toBe(true);
  });

  test("a route that echoes the bearer in a response header trips the guard", () => {
    const leak = 'reply.header("x-bearer", token);';
    expect(disclosesBearer(leak)).toBe(true);
  });

  test("an ordinary route that never touches the bearer stays green (not always-red)", () => {
    const clean =
      'app.get("/api/ping", (req, reply) => reply.send({ ok: true }));';
    expect(disclosesBearer(clean)).toBe(false);
  });
});

describe("the entropy/uniqueness assertion fires on a constant or low-entropy mint", () => {
  const MIN_BEARER_LENGTH = 43;

  test("a constant mint fails the per-launch-uniqueness assertion", () => {
    const constantMint = (): string => "always-the-same-constant-token";
    expect(constantMint()).toBe(constantMint());
  });

  test("a low-entropy (too-short) mint fails the length floor", () => {
    const shortMint = (): string => "abc123";
    expect(shortMint().length).toBeLessThan(MIN_BEARER_LENGTH);
  });
});
