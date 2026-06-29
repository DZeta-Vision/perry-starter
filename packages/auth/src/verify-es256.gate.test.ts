import { Buffer } from "node:buffer";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Hoisted per biome useTopLevelRegex: matches TypeScript source files.
const TS_FILE_RE = /\.tsx?$/;
// Test files are excluded from the banned-pattern scan: the planted offender
// lives in the paired mutation twin by design (it proves the detector fires),
// so it is a fixture string, not a real JWT-verify path.
const TEST_FILE_RE = /\.test\.tsx?$/;

// Red-phase acceptance gate for the offline ES256 identity-verification primitive.
//
// RED-PHASE CONTRACT: every test is `test.skip`. The module under test
// (`packages/auth/src/verify-es256.ts`) does NOT exist yet — it lands in this
// story's dev phase. Every import of the not-yet-existing module is a dynamic
// `await import(...)` INSIDE a skipped body; every source-scan `readFileSync`
// is likewise inside a skipped body. Top-level static imports are limited to
// `vitest` and `node:*`. Collection therefore never throws (all tests skipped,
// exit 0). The paired `verify-es256.mutation.test.ts` proves each detector goes
// red on a deliberately-wrong implementation (anti-vacuous; keeps the meta-gate
// green).
//
// The primitive is the SINGLE-SOURCED offline-verify leg shared by the browser
// and the daemon: it imports nothing from `better-auth` and nothing from
// `@perry-starter/env`, reaches only `crypto.subtle` + an injectable `fetch`,
// and issues NO auth decision (verify/cache only). Verification is FAIL-CLOSED.

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/auth/src
const VERIFY_MODULE_FILE = resolve(HERE, "verify-es256.ts");
const AUTH_WIRING_FILE = resolve(HERE, "index.ts");
const REPO_ROOT = resolve(HERE, "..", "..", ".."); // perry-starter/
const SESSION_STATE_SPECIFIER = "./session-state.ts";

// --- Source-scan detectors (comment-resistant) -------------------------------

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

// Strip comments so a token mentioned only in prose never trips a detector.
const stripComments = (src: string): string =>
  src.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

// Recursively collect tracked `.ts`/`.tsx` source under a package `src` dir.
const collectSource = (dir: string, out: string[]): string[] => {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      collectSource(full, out);
    } else if (
      TS_FILE_RE.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !TEST_FILE_RE.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
};

// The tracked source roots the CI-ban scan covers (gitignored BMAD dirs and
// the pinned `skills/` corpus are intentionally excluded).
const trackedSourceFiles = (): string[] => {
  const roots = ["packages", "apps"];
  const files: string[] = [];
  for (const root of roots) {
    collectSource(join(REPO_ROOT, root), files);
  }
  return files;
};

// --- Test-JWT signing helpers (non-prod, generated inline) -------------------

const b64url = (input: Uint8Array | string): string =>
  Buffer.from(input as Uint8Array).toString("base64url");

const segment = (obj: unknown): string => b64url(JSON.stringify(obj));

interface Es256Material {
  readonly jwk: JsonWebKey & { kid: string };
  readonly kid: string;
  readonly privateKey: CryptoKey;
}

const genEs256 = async (kid: string): Promise<Es256Material> => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey
  )) as JsonWebKey;
  return {
    privateKey: pair.privateKey,
    kid,
    jwk: { ...jwk, alg: "ES256", use: "sig", kid },
  };
};

// Sign a JWS over `{header}.{payload}` with ECDSA P-256 / SHA-256 (raw r‖s).
const signEs256 = async (
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: CryptoKey
): Promise<string> => {
  const signingInput = `${segment(header)}.${segment(payload)}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      new TextEncoder().encode(signingInput)
    )
  );
  return `${signingInput}.${b64url(sig)}`;
};

// Flip one byte of the signature segment to forge a tampered token.
const tamperSignature = (jwt: string): string => {
  const [h, p, s] = jwt.split(".");
  const raw = Buffer.from(s, "base64url");
  // Non-bitwise byte tamper (biome noBitwiseOperators): +1 mod 256 always differs.
  raw[0] = (raw[0] + 1) % 256;
  return `${h}.${p}.${raw.toString("base64url")}`;
};

const IAT = 1_700_000_000;
const FUTURE_EXP = IAT + 900; // +15 min
const PAST_EXP = IAT - 60; // already elapsed
const SCOPE = "user:alice";

describe("offline ES256 identity verification", () => {
  test("the jwt plugin keyPairConfig alg is explicitly ES256, never EdDSA", () => {
    const src = stripComments(readFileSync(AUTH_WIRING_FILE, "utf8"));
    // The explicit ES256 keyPairConfig is present on the jwt plugin...
    expect(ES256_CONFIG_RE.test(src)).toBe(true);
    // ...and no EdDSA/Ed25519 algorithm is configured for the JWT-verify leg
    // (an unset keyPairConfig.alg would silently resolve to EdDSA).
    expect(EDDSA_TOKEN_RE.test(src)).toBe(false);
  });

  test("a correctly-signed, unexpired token is accepted and yields the cached identity", async () => {
    const { verifyES256 } = await import("./verify-es256.ts");
    const mat = await genEs256("kid-accept");
    const jwt = await signEs256(
      { alg: "ES256", kid: mat.kid, typ: "JWT" },
      { iat: IAT, exp: FUTURE_EXP, sub: SCOPE, scope_user_id: SCOPE },
      mat.privateKey
    );
    const claims = await verifyES256(jwt, { keys: [mat.jwk] }, { now: IAT });
    expect(claims).not.toBeNull();
    expect((claims as { scope_user_id: string }).scope_user_id).toBe(SCOPE);
  });

  test("the JWKS is fetched once and cached; a kid-miss refetches exactly once", async () => {
    const { createOfflineVerifier } = await import("./verify-es256.ts");
    const matA = await genEs256("kid-A");
    const matB = await genEs256("kid-B");
    let currentKeys: JsonWebKey[] = [matA.jwk];
    let fetchCalls = 0;
    const fetchImpl = (() => {
      fetchCalls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ keys: currentKeys }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    }) as unknown as typeof fetch;

    const verifier = createOfflineVerifier({
      jwksUrl: "http://127.0.0.1:3000/api/auth/jwks",
      fetchImpl,
    });
    const jwtA1 = await signEs256(
      { alg: "ES256", kid: matA.kid, typ: "JWT" },
      { iat: IAT, exp: FUTURE_EXP, scope_user_id: SCOPE },
      matA.privateKey
    );
    const jwtA2 = await signEs256(
      { alg: "ES256", kid: matA.kid, typ: "JWT" },
      { iat: IAT, exp: FUTURE_EXP, scope_user_id: SCOPE },
      matA.privateKey
    );
    await verifier.verify(jwtA1, { now: IAT });
    await verifier.verify(jwtA2, { now: IAT });
    // Two verifies sharing one kid → exactly one fetch (cached).
    expect(fetchCalls).toBe(1);

    // A new kid arrives → exactly one refetch (kid-miss), never per-call.
    currentKeys = [matA.jwk, matB.jwk];
    const jwtB = await signEs256(
      { alg: "ES256", kid: matB.kid, typ: "JWT" },
      { iat: IAT, exp: FUTURE_EXP, scope_user_id: SCOPE },
      matB.privateKey
    );
    await verifier.verify(jwtB, { now: IAT });
    expect(fetchCalls).toBe(2);
  });

  test("the verify module never calls server-side verifyJWT and imports no better-auth", () => {
    const src = stripComments(readFileSync(VERIFY_MODULE_FILE, "utf8"));
    expect(VERIFY_JWT_RE.test(src)).toBe(false);
    expect(BETTER_AUTH_IMPORT_RE.test(src)).toBe(false);
  });

  test("verification is never gated on a SubtleCrypto.supports() probe", () => {
    const src = stripComments(readFileSync(VERIFY_MODULE_FILE, "utf8"));
    expect(SUPPORTS_PROBE_RE.test(src)).toBe(false);
  });

  test("a tampered-signature token is rejected (fail closed)", async () => {
    const { verifyES256 } = await import("./verify-es256.ts");
    const mat = await genEs256("kid-tamper");
    const good = await signEs256(
      { alg: "ES256", kid: mat.kid, typ: "JWT" },
      { iat: IAT, exp: FUTURE_EXP, scope_user_id: SCOPE },
      mat.privateKey
    );
    const forged = tamperSignature(good);
    expect(
      await verifyES256(forged, { keys: [mat.jwk] }, { now: IAT })
    ).toBeNull();
    // control: the untampered token still verifies (not blanket-rejecting).
    expect(
      await verifyES256(good, { keys: [mat.jwk] }, { now: IAT })
    ).not.toBeNull();
  });

  test("a token whose exp is in the past is rejected (fail closed)", async () => {
    const { verifyES256 } = await import("./verify-es256.ts");
    const mat = await genEs256("kid-exp");
    const expired = await signEs256(
      { alg: "ES256", kid: mat.kid, typ: "JWT" },
      { iat: IAT - 3600, exp: PAST_EXP, scope_user_id: SCOPE },
      mat.privateKey
    );
    expect(
      await verifyES256(expired, { keys: [mat.jwk] }, { now: IAT })
    ).toBeNull();
  });

  test("an EdDSA-signed token is rejected by the ES256 alg allowlist (fail closed)", async () => {
    const { verifyES256 } = await import("./verify-es256.ts");
    const es = await genEs256("kid-es-for-jwks");
    const ed = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const signingInput = `${segment({ alg: "EdDSA", kid: es.kid, typ: "JWT" })}.${segment({ iat: IAT, exp: FUTURE_EXP, scope_user_id: SCOPE })}`;
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        ed.privateKey,
        new TextEncoder().encode(signingInput)
      )
    );
    const eddsaJwt = `${signingInput}.${b64url(sig)}`;
    expect(
      await verifyES256(eddsaJwt, { keys: [es.jwk] }, { now: IAT })
    ).toBeNull();
  });

  test("an alg:none token is rejected by the ES256 alg allowlist (fail closed)", async () => {
    const { verifyES256 } = await import("./verify-es256.ts");
    const mat = await genEs256("kid-none");
    const header = segment({ alg: "none", kid: mat.kid, typ: "JWT" });
    const payload = segment({
      iat: IAT,
      exp: FUTURE_EXP,
      scope_user_id: SCOPE,
    });
    const noneJwt = `${header}.${payload}.`; // empty signature segment
    expect(
      await verifyES256(noneJwt, { keys: [mat.jwk] }, { now: IAT })
    ).toBeNull();
  });

  test("jsonwebtoken-with-EdDSA is banned on every JWT-verify path in tracked source", () => {
    const offenders: string[] = [];
    for (const file of trackedSourceFiles()) {
      const src = stripComments(readFileSync(file, "utf8"));
      if (JSONWEBTOKEN_IMPORT_RE.test(src) && JWT_VERIFY_EDDSA_RE.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the verify primitive issues no auth-decision side-effect (verify/cache only)", () => {
    const src = stripComments(readFileSync(VERIFY_MODULE_FILE, "utf8"));
    expect(DECISION_SIDE_EFFECT_RE.test(src)).toBe(false);
  });

  test("an offline verify-failure composes into LOCAL_GRACE, never SESSION_EXPIRED", async () => {
    // The verify verdict (null = rejected/expired) must NOT itself log the user
    // out. Composed with the Story-1.6 reducer while offline it stays in
    // LOCAL_GRACE; SESSION_EXPIRED is reachable only on a later FAILED online
    // refresh. The never-degrade invariant is OWNED by 1.6 (referenced here).
    const { evaluateSession } = await import(SESSION_STATE_SPECIFIER);
    // A short-lived token (issued at IAT, 15-min life) whose expiry has elapsed
    // while the client stayed offline — the reducer's clock terms are in ms.
    const claims = {
      iat: IAT * 1000,
      exp: FUTURE_EXP * 1000,
      scope_user_id: SCOPE,
    };
    const wellPastExpiry = (IAT + 3600) * 1000; // 1h after issue, past the grace skew
    const offline = evaluateSession({
      claims,
      now: wellPastExpiry,
      online: false,
    });
    expect(offline).toBe("LOCAL_GRACE");
    const failedRefresh = evaluateSession({
      claims,
      now: wellPastExpiry,
      online: true,
      refreshOutcome: "failed",
    });
    expect(failedRefresh).toBe("SESSION_EXPIRED");
  });
});
