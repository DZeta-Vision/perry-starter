// The single-sourced offline ES256 identity-verification primitive.
//
// It verifies a presented JWT against a pinned ES256 (ECDSA P-256 / SHA-256)
// JWKS using only `crypto.subtle` + Web APIs (`atob`, `TextEncoder`, `fetch`),
// so the SAME implementation is consumed by the browser tier AND the native
// daemon tier with no drift. It imports nothing from the auth SDK and nothing
// from the env contract: no SDK, no WASM, no prebuilt-JS — it survives the
// native compile and stays daemon-safe.
//
// Boundaries (owned elsewhere, deliberately NOT done here):
//   - This primitive issues NO auth decision. It only verifies and caches; its
//     sole outputs are the verified claims (or `null`) plus the cached JWKS.
//   - The untrusted client REPLICATES verification; it never calls the cloud
//     authority's server-side verify helper (a layering violation) and never
//     mints or authorizes anything.
//   - The never-degrade transition (an offline verify-failure stays operational
//     in a local grace state) is owned by the pure session-state reducer; the
//     expired-session error envelope/routing is owned by the auth-error layer.
//     A `null` here composes into those — it is not itself a logout.
//
// Verification is FAIL-CLOSED: anything not provably an unexpired,
// correctly-ES256-signed token is rejected (`null`).

// The accepted algorithm allowlist. ES256 (ECDSA P-256 / SHA-256) is the ONLY
// accepted JWT algorithm — EdDSA / "none" / anything else is rejected on this
// allowlist independent of the cryptographic verify.
const ACCEPTED_ALG = "ES256";

// The WebCrypto algorithm descriptors for the ES256 verify recipe.
const ECDSA_IMPORT_PARAMS = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDSA_VERIFY_PARAMS = { name: "ECDSA", hash: "SHA-256" } as const;

const MILLIS_PER_SECOND = 1000;

// A public JWK plus the `kid` selector. The platform `JsonWebKey` type omits
// `kid` (it is a JWS/JWKS header field, not a WebCrypto key parameter), so we
// extend it — `importKey` still accepts it as a `JsonWebKey`.
export interface PublicJwk extends JsonWebKey {
  readonly kid?: string;
}

// The public ES256 JWK set, exactly as served by the cloud authority's JWKS
// endpoint: `{ keys: [{ kty:"EC", alg:"ES256", crv:"P-256", x, y, kid, use:"sig" }] }`.
export interface Jwks {
  readonly keys: PublicJwk[];
}

// The decoded, cryptographically-verified claim set. `exp` is the only field the
// verify primitive itself inspects (for the unexpired check); the remaining
// claims (subject, scope, role, active organization) are passed through to the
// caller untouched.
export interface VerifiedClaims {
  readonly exp: number;
  readonly [claim: string]: unknown;
}

export interface VerifyOptions {
  // Injected clock reading in SECONDS (the JWT `exp` unit). Defaults to the wall
  // clock; tests inject a fixed value for deterministic expiry.
  readonly now?: number;
}

export interface OfflineVerifierConfig {
  // Injectable `fetch` so the JWKS source is a test seam and the daemon/browser
  // bind their own transport. Defaults to the ambient `fetch`.
  readonly fetchImpl?: typeof fetch;
  readonly jwksUrl: string;
}

export interface OfflineVerifier {
  verify(jwt: string, opts?: VerifyOptions): Promise<VerifiedClaims | null>;
}

// Decode a base64url segment to bytes via the standard Web `atob` (no Node
// Buffer, so the module stays browser/daemon-safe).
const base64UrlToBytes = (segment: string): Uint8Array => {
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

// Parse a base64url JSON segment into an object, or `null` if it is not
// well-formed JSON describing an object (fail-closed on malformed input).
const decodeJsonSegment = (segment: string): Record<string, unknown> | null => {
  try {
    const text = new TextDecoder().decode(base64UrlToBytes(segment));
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === "object") {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
};

// Read just the JWT header (used to resolve the signing `kid` before any verify
// or — in the cached verifier — any JWKS fetch).
const decodeHeader = (jwt: string): Record<string, unknown> | null => {
  const header = jwt.split(".")[0];
  return header === undefined ? null : decodeJsonSegment(header);
};

// Verify a presented JWT offline against a PROVIDED ES256 JWKS. Returns the
// verified claims on a correctly-signed, unexpired ES256 token; `null` on
// anything else (tampered signature, past `exp`, unexpected/absent algorithm,
// missing/mismatched `kid`, malformed token). Never gates on a
// `crypto.subtle` capability probe — the verify path is reached unconditionally.
export const verifyES256 = async (
  jwt: string,
  jwks: Jwks,
  opts?: VerifyOptions
): Promise<VerifiedClaims | null> => {
  try {
    const now = opts?.now ?? Math.floor(Date.now() / MILLIS_PER_SECOND);
    const [headerSeg, payloadSeg, signatureSeg] = jwt.split(".");
    if (
      headerSeg === undefined ||
      payloadSeg === undefined ||
      signatureSeg === undefined
    ) {
      return null;
    }

    const header = decodeJsonSegment(headerSeg);
    // Explicit ES256 allowlist — reject EdDSA / "none" / anything else here,
    // BEFORE and independent of the cryptographic verify.
    if (header === null || header.alg !== ACCEPTED_ALG) {
      return null;
    }

    const jwk = jwks.keys.find((key) => key.kid === header.kid);
    if (jwk === undefined) {
      return null;
    }

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      ECDSA_IMPORT_PARAMS,
      false,
      ["verify"]
    );
    const signature = base64UrlToBytes(signatureSeg);
    const signingInput = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
    const signatureOk = await crypto.subtle.verify(
      ECDSA_VERIFY_PARAMS,
      key,
      signature,
      signingInput
    );
    if (!signatureOk) {
      return null;
    }

    const payload = decodeJsonSegment(payloadSeg);
    // Fail-closed on a missing/non-numeric `exp` or an elapsed one.
    if (
      payload === null ||
      typeof payload.exp !== "number" ||
      now >= payload.exp
    ) {
      return null;
    }
    return payload as VerifiedClaims;
  } catch {
    // Any decode/import/verify fault is a rejection, never a throw to the caller.
    return null;
  }
};

// A JWKS-caching verifier: it fetches the public JWKS ONCE, caches it, and
// refetches ONLY on a `kid` miss (never per call). The cloud authority remains
// the sole issuer; this only verifies and caches.
export const createOfflineVerifier = ({
  jwksUrl,
  fetchImpl,
}: OfflineVerifierConfig): OfflineVerifier => {
  const fetchJwks = fetchImpl ?? fetch;
  let cache: Jwks | null = null;

  const refresh = async (): Promise<void> => {
    const response = await fetchJwks(jwksUrl);
    cache = (await response.json()) as Jwks;
  };

  const cacheHasKid = (kid: unknown): boolean =>
    cache?.keys.some((key) => key.kid === kid) ?? false;

  return {
    verify: async (jwt, opts) => {
      const kid = decodeHeader(jwt)?.kid;
      // Fetch once on a cold cache; otherwise refetch only when the presented
      // `kid` is absent from the cached set (key rotation / new key).
      if (!cacheHasKid(kid)) {
        await refresh();
      }
      return verifyES256(jwt, cache ?? { keys: [] }, opts);
    },
  };
};
