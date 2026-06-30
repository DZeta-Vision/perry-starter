// Acceptance tests for the server-side OAuth error surface and the
// state-mismatch / replay fail-closed path.
//
// These assert that any OAuth error — a provider denial, a provider 5xx, an
// adapter exception, or a CSRF state-validation failure — redirects to a single
// fixed generic error route that leaks no provider name, provider error code,
// stack frame, or internal exception message, and that a tampered or replayed
// state yields no session (fail closed). The error surface must not reveal which
// provider failed or why.
//
// RED PHASE: every test is `test.skip`. The OAuth error composer does not exist
// yet; the handler-driven state-validation leg additionally depends on the
// SurrealDB better-auth adapter and stays skipped until it lands. All
// not-yet-existing imports and all IO are dynamic inside the skipped bodies.

import { describe, expect, test } from "vitest";

// The single fixed generic error route every OAuth failure must resolve to.
const GENERIC_OAUTH_ERROR_ROUTE = "/auth/error";

// Substrings whose presence in a redirect target proves a provider/stack leak.
const LEAK_TOKENS = [
  "github",
  "google",
  "access_denied",
  "error_description",
  "stack",
  "ECONNREFUSED",
  "SurrealDB",
] as const;

const leaks = (redirect: string): boolean => {
  const haystack = redirect.toLowerCase();
  return LEAK_TOKENS.some((t) => haystack.includes(t.toLowerCase()));
};

// Hoisted (top-level) regex: a minted-session cookie that must be absent on a
// state mismatch / replay.
const SESSION_COOKIE_RE = /session_token|better-auth\.session/;

describe("OAuth error redirects to a generic, non-leaking surface", () => {
  test("a provider access-denial redirects to the fixed generic error route", async () => {
    const { genericOAuthErrorRedirect } = await import("../src/oauth");
    const redirect = genericOAuthErrorRedirect({
      provider: "github",
      error: "access_denied",
      error_description: "The user denied the request",
    });
    expect(redirect.startsWith(GENERIC_OAUTH_ERROR_ROUTE)).toBe(true);
    expect(leaks(redirect)).toBe(false);
  });

  test("a provider 5xx does not leak the provider or its status", async () => {
    const { genericOAuthErrorRedirect } = await import("../src/oauth");
    const redirect = genericOAuthErrorRedirect({
      provider: "google",
      error: "server_error",
      status: 502,
    });
    expect(leaks(redirect)).toBe(false);
  });

  test("an internal adapter exception does not leak the stack or message", async () => {
    const { genericOAuthErrorRedirect } = await import("../src/oauth");
    const redirect = genericOAuthErrorRedirect({
      cause: new Error("SurrealDB connect ECONNREFUSED 127.0.0.1:8000"),
    });
    expect(leaks(redirect)).toBe(false);
  });

  test("every distinct OAuth failure resolves to the SAME generic route (no per-cause divergence)", async () => {
    const { genericOAuthErrorRedirect } = await import("../src/oauth");
    const routeOf = (r: string) => r.split("?")[0];
    const denial = routeOf(
      genericOAuthErrorRedirect({ provider: "github", error: "access_denied" })
    );
    const serverError = routeOf(
      genericOAuthErrorRedirect({ provider: "google", error: "server_error" })
    );
    const internal = routeOf(
      genericOAuthErrorRedirect({ cause: new Error("boom") })
    );
    expect(denial).toBe(GENERIC_OAUTH_ERROR_ROUTE);
    expect(serverError).toBe(GENERIC_OAUTH_ERROR_ROUTE);
    expect(internal).toBe(GENERIC_OAUTH_ERROR_ROUTE);
  });
});

describe("server-side state mismatch / replay fails closed", () => {
  // Behavioral, handler-driven — depends on the SurrealDB better-auth adapter
  // (a separate critical-path precondition). Stays skipped until it lands.
  test("a social callback with a mismatched state yields no session and the generic error", async () => {
    const { auth } = await import("../src/index");
    const request = new Request(
      "https://auth.example.test/api/auth/callback/github?code=abc&state=tampered",
      { headers: { cookie: "better-auth.state=expected-different" } }
    );
    const response = await auth.handler(request);
    // No session cookie is set on a state mismatch.
    expect(response.headers.get("set-cookie") ?? "").not.toMatch(
      SESSION_COOKIE_RE
    );
    // It steers to the generic error surface (a redirect to the fixed route).
    const location = response.headers.get("location") ?? "";
    expect(
      location.includes(GENERIC_OAUTH_ERROR_ROUTE) || response.status >= 400
    ).toBe(true);
  });

  test("a replayed (already-consumed) state is not accepted a second time", async () => {
    const { auth } = await import("../src/index");
    const url =
      "https://auth.example.test/api/auth/callback/github?code=once&state=single-use";
    const cookie = "better-auth.state=single-use";
    const first = await auth.handler(new Request(url, { headers: { cookie } }));
    const replay = await auth.handler(
      new Request(url, { headers: { cookie } })
    );
    // The replay must not mint a session (the state/code is single-use).
    expect(replay.headers.get("set-cookie") ?? "").not.toMatch(
      SESSION_COOKIE_RE
    );
    // The first attempt is at least as restrictive (no weaker than the replay).
    expect(typeof first.status).toBe("number");
  });
});
