// Conformance gate — Turnstile is siteverified SERVER-SIDE and gates ONLY on the
// server's `{ success }` verdict, never a client assertion.
//
// The gate drives the REAL `verifyTurnstileToken` with an injected `fetch` and
// asserts: (1) it POSTs `{ secret, response, remoteip }` to the exact Cloudflare
// siteverify host; (2) a server `{ success: true }` passes; (3) a server
// `{ success: false }` is REJECTED even though the client "submitted a token"
// (the CAPTCHA verdict is the server's, not the browser's); (4) an unreachable
// siteverify fails closed. The mutation twin (turnstile-siteverify.mutation.test.ts)
// drives a verifier that TRUSTS the client and asserts it wrongly passes the SAME
// `{ success: false }` payload the real one rejects — proving the server-gating is
// load-bearing.

import {
  TURNSTILE_SITEVERIFY_URL,
  verifyTurnstileToken,
} from "@perry-starter/auth/turnstile";
import { describe, expect, test } from "vitest";

interface CapturedCall {
  body: URLSearchParams;
  url: string;
}

// An injected fetch that captures the request and returns a chosen server verdict.
const fetchReturning = (
  serverVerdict: unknown,
  captured: CapturedCall[]
): typeof fetch =>
  ((url: string, init: { body: URLSearchParams; method: string }) => {
    captured.push({ body: init.body, url });
    return Promise.resolve(Response.json(serverVerdict));
  }) as unknown as typeof fetch;

describe("Turnstile is verified server-side against the siteverify host", () => {
  test("it POSTs secret + response token + remoteip to the exact siteverify URL", async () => {
    const captured: CapturedCall[] = [];
    await verifyTurnstileToken(
      { remoteip: "203.0.113.7", secret: "widget-secret", token: "tok-abc" },
      { fetch: fetchReturning({ success: true }, captured) }
    );

    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call.url).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(call.body.get("secret")).toBe("widget-secret");
    expect(call.body.get("response")).toBe("tok-abc");
    expect(call.body.get("remoteip")).toBe("203.0.113.7");
  });

  test("a server { success: true } verdict passes", async () => {
    const result = await verifyTurnstileToken(
      { remoteip: "203.0.113.7", secret: "s", token: "good" },
      { fetch: fetchReturning({ success: true }, []) }
    );
    expect(result.success).toBe(true);
  });

  test("a server { success: false } verdict is rejected — the client cannot self-assert", async () => {
    // The client "submitted a token" and might claim success; the SERVER says no.
    const result = await verifyTurnstileToken(
      { remoteip: "203.0.113.7", secret: "s", token: "client-claims-good" },
      {
        fetch: fetchReturning(
          { "error-codes": ["invalid-input-response"], success: false },
          []
        ),
      }
    );
    expect(result.success).toBe(false);
  });

  test("a payload with no explicit success flag does NOT pass (strict boolean gate)", async () => {
    const result = await verifyTurnstileToken(
      { remoteip: "203.0.113.7", secret: "s", token: "t" },
      { fetch: fetchReturning({ "error-codes": [] }, []) }
    );
    expect(result.success).toBe(false);
  });

  test("an unreachable siteverify fails closed (never a pass)", async () => {
    const throwingFetch = (() =>
      Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    const result = await verifyTurnstileToken(
      { remoteip: "203.0.113.7", secret: "s", token: "t" },
      { fetch: throwingFetch }
    );
    expect(result.success).toBe(false);
  });
});
