import { describe, expect, test } from "vitest";
import { resolveOfflineSessionState } from "./offline-session";
import type { SessionClaims } from "./session-state";
import { createOfflineVerifier } from "./verify-es256";

// The offline session-state consumer is driven against the REAL offline ES256
// verifier (createOfflineVerifier) — not a synthetic double — so the security
// property is proven on the production path. The verifier's only injected seam
// is its `fetch`, which here rejects, reproducing a real cold-cache / transport
// fault: the verifier has no cached JWKS, must fetch the key set, and the fetch
// fails because the device is offline. That makes the real verifier THROW.

const MS_PER_SECOND = 1000;
const IAT_MS = 1_700_000_000_000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

// A minimally well-formed JWT (header.payload.signature) so the verifier decodes
// a header and reaches its JWKS (re)fetch — which then throws while offline.
const base64Url = (value: object): string =>
  btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const FIXTURE_JWT = `${base64Url({ alg: "ES256", kid: "k1" })}.${base64Url({
  exp: Math.floor(IAT_MS / MS_PER_SECOND) + 60,
})}.c2ln`;

// A claim set whose short-lived token has already expired, but which is still
// within the absolute 8-h ceiling — the window in which an offline client must
// sit in LOCAL_GRACE rather than expire.
const expiredButWithinCeiling: SessionClaims = {
  exp: IAT_MS - 60_000,
  iat: IAT_MS,
  scope_user_id: "user:alice",
};

// A `fetch` that always rejects — the transport fault an offline device sees.
const offlineFetch: typeof fetch = () =>
  Promise.reject(new Error("network unreachable (offline)"));

describe("the offline session consumer never crashes or logs out on a verifier transport fault", () => {
  test("an offline cold-cache verifier throw maps to LOCAL_GRACE, not SESSION_EXPIRED, and never propagates", async () => {
    const verifier = createOfflineVerifier({
      jwksUrl: "https://api.perryts.com/api/auth/jwks",
      fetchImpl: offlineFetch,
    });

    const state = await resolveOfflineSessionState({
      claims: expiredButWithinCeiling,
      jwt: FIXTURE_JWT,
      now: IAT_MS + Math.floor(EIGHT_HOURS_MS / 2),
      online: false,
      verifier,
    });

    expect(state).toBe("LOCAL_GRACE");
  });

  test("the verifier really does throw on the offline cold-cache fetch (the fault the consumer absorbs is genuine)", async () => {
    const verifier = createOfflineVerifier({
      jwksUrl: "https://api.perryts.com/api/auth/jwks",
      fetchImpl: offlineFetch,
    });

    await expect(verifier.verify(FIXTURE_JWT)).rejects.toThrow();
  });

  test("the hard SESSION_EXPIRED terminal still fires on a later online and FAILED refresh", async () => {
    const verifier = createOfflineVerifier({
      jwksUrl: "https://api.perryts.com/api/auth/jwks",
      fetchImpl: offlineFetch,
    });

    const state = await resolveOfflineSessionState({
      claims: expiredButWithinCeiling,
      jwt: FIXTURE_JWT,
      now: IAT_MS + Math.floor(EIGHT_HOURS_MS / 2),
      online: true,
      refreshOutcome: "failed",
      verifier,
    });

    expect(state).toBe("SESSION_EXPIRED");
  });
});
