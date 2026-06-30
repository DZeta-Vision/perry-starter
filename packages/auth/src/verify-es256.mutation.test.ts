import { describe, expect, test } from "vitest";

// Anti-vacuous mutation twin for `verify-es256.gate.test.ts`.
//
// RED-PHASE CONTRACT: every test is `test.skip`. This file is SELF-CONTAINED —
// it imports the not-yet-existing `verify-es256.ts` NOT AT ALL. Instead it
// replicates each load-bearing detector / decision and runs it against a
// deliberately-WRONG implementation (expecting a violation) alongside a CLEAN
// control (expecting none), proving the gate's assertions can actually go red.
// Shipping this twin keeps `node scripts/meta-gate.mjs` green for the paired
// `verify-es256.gate.test.ts`.

// --- Replicated source-scan detectors (mirror the gate) ----------------------

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:"'`])\/\/[^\n]*/g;
const ES256_CONFIG_RE = /keyPairConfig\s*:\s*\{\s*alg\s*:\s*["']ES256["']/;
const EDDSA_TOKEN_RE = /\b(?:EdDSA|Ed25519)\b/;
const SUPPORTS_PROBE_RE = /\.supports\s*\(/;
const VERIFY_JWT_RE = /\bverifyJWT\b/;
const BETTER_AUTH_IMPORT_RE = /from\s+["']better-auth(?:\/[^"']*)?["']/;
const JSONWEBTOKEN_IMPORT_RE =
  /(?:from\s+["']jsonwebtoken["'])|(?:require\(\s*["']jsonwebtoken["']\s*\))/;
const JWT_VERIFY_EDDSA_RE = /algorithms\s*:\s*\[[^\]]*\b(?:EdDSA|Ed25519)\b/;
const DECISION_SIDE_EFFECT_RE =
  /\b(?:signOut|sign-out|SESSION_EXPIRED)\b|router\.\s*navigate|location\.href|window\.location/;

const stripComments = (src: string): string =>
  src.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

// --- Modeled verify decision (mirrors the real verify logic, sans real crypto) -------

interface DecodedToken {
  readonly alg: string;
  readonly exp: number;
  readonly sigValid: boolean;
}

type VerifyFn = (
  token: DecodedToken,
  now: number
) => Record<string, unknown> | null;

const CLAIMS = { scope_user_id: "user:alice" } as const;

// Correct, fail-closed verify: ES256-only allowlist + valid signature + unexpired.
const failClosedVerify: VerifyFn = (t, now) =>
  t.alg === "ES256" && t.sigValid && now < t.exp ? { ...CLAIMS } : null;

// WRONG: no alg allowlist — accepts EdDSA / none.
const skipAlgVerify: VerifyFn = (t, now) =>
  t.sigValid && now < t.exp ? { ...CLAIMS } : null;

// WRONG: ignores exp — accepts an expired token.
const ignoreExpVerify: VerifyFn = (t) =>
  t.alg === "ES256" && t.sigValid ? { ...CLAIMS } : null;

// WRONG: decode-only (fail-open) — ignores the signature-validity flag.
const decodeOnlyVerify: VerifyFn = (t, now) =>
  t.alg === "ES256" && now < t.exp ? { ...CLAIMS } : null;

const NOW = 1_700_000_000;
const FUTURE = NOW + 900;
const PAST = NOW - 60;

// Replicated verify checkers — each returns true when the verify behaves correctly.
const eddsaRejected = (v: VerifyFn): boolean =>
  v({ alg: "EdDSA", exp: FUTURE, sigValid: true }, NOW) === null;
// `alg:none` is modeled like the EdDSA case (sigValid: true) so that ONLY the
// alg allowlist can stop it — a verify that skips the allowlist must accept it.
const noneRejected = (v: VerifyFn): boolean =>
  v({ alg: "none", exp: FUTURE, sigValid: true }, NOW) === null;
const expiredRejected = (v: VerifyFn): boolean =>
  v({ alg: "ES256", exp: PAST, sigValid: true }, NOW) === null;
const tamperedRejected = (v: VerifyFn): boolean =>
  v({ alg: "ES256", exp: FUTURE, sigValid: false }, NOW) === null;
const validAccepted = (v: VerifyFn): boolean =>
  v({ alg: "ES256", exp: FUTURE, sigValid: true }, NOW) !== null;

describe("verify-es256 anti-vacuous twins", () => {
  test("the fail-closed verify passes every verify checker (clean control)", () => {
    expect(eddsaRejected(failClosedVerify)).toBe(true);
    expect(noneRejected(failClosedVerify)).toBe(true);
    expect(expiredRejected(failClosedVerify)).toBe(true);
    expect(tamperedRejected(failClosedVerify)).toBe(true);
    expect(validAccepted(failClosedVerify)).toBe(true);
  });

  test("a verify that skips the alg allowlist reddens the EdDSA and none checkers", () => {
    expect(eddsaRejected(skipAlgVerify)).toBe(false);
    expect(noneRejected(skipAlgVerify)).toBe(false);
  });

  test("a verify that ignores exp reddens the expired checker", () => {
    expect(expiredRejected(ignoreExpVerify)).toBe(false);
  });

  test("a decode-only (fail-open) verify reddens the tampered checker", () => {
    expect(tamperedRejected(decodeOnlyVerify)).toBe(false);
  });

  test("the alg-config detector flags a wiring missing the explicit ES256 keyPairConfig", () => {
    const missing = "jwt({ jwks: {} })";
    const eddsa = `jwt({ jwks: { keyPairConfig: { alg: "EdDSA" } } })`;
    const clean = `jwt({ jwks: { keyPairConfig: { alg: "ES256" } } })`;
    expect(ES256_CONFIG_RE.test(stripComments(missing))).toBe(false);
    expect(EDDSA_TOKEN_RE.test(stripComments(eddsa))).toBe(true);
    expect(ES256_CONFIG_RE.test(stripComments(clean))).toBe(true);
    expect(EDDSA_TOKEN_RE.test(stripComments(clean))).toBe(false);
  });

  test("the supports()-probe detector flags a verify gated on SubtleCrypto.supports", () => {
    const gated = `if (!crypto.subtle.supports("verify", "ECDSA")) return null;`;
    const clean =
      "const ok = await crypto.subtle.verify(alg, key, sig, input);";
    expect(SUPPORTS_PROBE_RE.test(stripComments(gated))).toBe(true);
    expect(SUPPORTS_PROBE_RE.test(stripComments(clean))).toBe(false);
  });

  test("the client-replication detector flags a verifyJWT call or a better-auth import", () => {
    const offendA = `import { verifyJWT } from "better-auth";`;
    const offendB = "const r = await verifyJWT(token);";
    const clean = `const key = await crypto.subtle.importKey("jwk", jwk, ecdsa, false, ["verify"]);`;
    expect(BETTER_AUTH_IMPORT_RE.test(stripComments(offendA))).toBe(true);
    expect(VERIFY_JWT_RE.test(stripComments(offendB))).toBe(true);
    expect(BETTER_AUTH_IMPORT_RE.test(stripComments(clean))).toBe(false);
    expect(VERIFY_JWT_RE.test(stripComments(clean))).toBe(false);
  });

  test("the CI-ban detector flags jsonwebtoken-with-EdDSA on a JWT-verify path", () => {
    const offend = [
      `import jwt from "jsonwebtoken";`,
      `jwt.verify(token, key, { algorithms: ["EdDSA"] });`,
    ].join("\n");
    const clean = `const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, input);`;
    const offendStripped = stripComments(offend);
    expect(
      JSONWEBTOKEN_IMPORT_RE.test(offendStripped) &&
        JWT_VERIFY_EDDSA_RE.test(offendStripped)
    ).toBe(true);
    const cleanStripped = stripComments(clean);
    expect(
      JSONWEBTOKEN_IMPORT_RE.test(cleanStripped) &&
        JWT_VERIFY_EDDSA_RE.test(cleanStripped)
    ).toBe(false);
  });

  test("the decision-free detector flags a verify that signs the user out on failure", () => {
    const offend = `if (!claims) { authClient.signOut(); emit("SESSION_EXPIRED"); }`;
    const clean = "if (!verified) return null;";
    expect(DECISION_SIDE_EFFECT_RE.test(stripComments(offend))).toBe(true);
    expect(DECISION_SIDE_EFFECT_RE.test(stripComments(clean))).toBe(false);
  });

  test("a token mentioned only in a comment never trips a detector (comment-resistant)", () => {
    const proseOnly =
      "// uses ECDSA, never EdDSA, and never crypto.subtle.supports()";
    expect(EDDSA_TOKEN_RE.test(stripComments(proseOnly))).toBe(false);
    expect(SUPPORTS_PROBE_RE.test(stripComments(proseOnly))).toBe(false);
  });
});
