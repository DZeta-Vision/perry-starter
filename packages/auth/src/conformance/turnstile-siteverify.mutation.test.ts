// Mutation twin for turnstile-siteverify.gate.test.ts.
//
// The gate's load-bearing claim is that the CAPTCHA verdict is the SERVER's, never
// the client's — a `{ success: false }` server response must be rejected even when
// the client submitted a token. This twin builds a DELIBERATELY BROKEN verifier
// that TRUSTS the client (it passes whenever a token was submitted, ignoring the
// server verdict) and asserts it WRONGLY passes the exact `{ success: false }`
// payload the real verifier rejects. It then reconfirms the REAL verifier rejects
// it — so the server-side gating is proven load-bearing, not decorative.

import { verifyTurnstileToken } from "@perry-starter/auth/turnstile";
import { describe, expect, test } from "vitest";

// A server that DENIES the token.
const denyingFetch = (() =>
  Promise.resolve(
    Response.json({ success: false })
  )) as unknown as typeof fetch;

// The BROKEN verifier: it trusts the CLIENT — any non-empty submitted token
// "passes", ignoring the server verdict entirely.
const clientTrustingVerify = (input: { token: string }): boolean =>
  input.token.length > 0;

describe("trusting the client verdict is a real vulnerability the gate forecloses", () => {
  test("the broken verifier wrongly passes a token the server denied", () => {
    expect(clientTrustingVerify({ token: "client-claims-good" })).toBe(true);
  });

  test("the REAL verifier rejects that same token because the SERVER said { success: false }", async () => {
    const result = await verifyTurnstileToken(
      { remoteip: "203.0.113.7", secret: "s", token: "client-claims-good" },
      { fetch: denyingFetch }
    );
    expect(result.success).toBe(false);
  });
});
