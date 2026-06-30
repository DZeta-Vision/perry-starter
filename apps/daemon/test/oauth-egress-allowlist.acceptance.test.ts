// Acceptance tests for the daemon's outbound fetch to OAuth-provider hosts.
//
// These assert that the daemon's egress to the configured OAuth-provider hosts
// is constrained to the HTTPS host-pinned allowlist: an allowlisted OAuth host
// over https delegates (the anti-vacuous positive), a host not on the allowlist
// throws AND audits, a non-https scheme to an allowlisted OAuth host throws, and
// an allowlisted OAuth host that 3xx-bounces to an off-list host is rejected on
// the re-validated redirect hop. The provider host strings are sourced from the
// deployment topology (GitHub + Google OAuth endpoints), not invented.
//
// RED PHASE: every test is `test.skip`. The OAuth-provider hosts are not yet on
// EGRESS_ALLOWLIST (added in the Execute phase); `guardedFetch` already exists
// and injects `fetch`, so these drive the real guard with a fake fetch — no
// live network, no global stub. All imports are dynamic inside the skipped
// bodies; the only top-level import is vitest.

import { describe, expect, test } from "vitest";

// The OAuth-provider hosts the Execute phase adds to the allowlist.
const GITHUB_OAUTH_HOST = "github.com";
const GOOGLE_TOKEN_HOST = "oauth2.googleapis.com";
const OFF_LIST_HOST = "evil.example.test";

const okResponse = () => new Response("{}", { status: 200 });

// Hoisted (top-level) regex: the guard's denial message.
const EGRESS_DENIED_RE = /egress denied/i;

describe("daemon OAuth egress is HTTPS host-pinned to the allowlist", () => {
  test("an allowlisted OAuth host over https delegates to the injected fetch", async () => {
    const { guardedFetch } = await import("../src/egress-allowlist");
    let called = "";
    const fakeFetch: typeof globalThis.fetch = (input) => {
      called = typeof input === "string" ? input : (input as URL).href;
      return Promise.resolve(okResponse());
    };
    const res = await guardedFetch(
      `https://${GITHUB_OAUTH_HOST}/login/oauth/access_token`,
      { method: "POST" },
      { fetch: fakeFetch }
    );
    expect(res.status).toBe(200);
    expect(new URL(called).hostname).toBe(GITHUB_OAUTH_HOST);
  });

  test("a Google OAuth token host over https is allowed", async () => {
    const { guardedFetch } = await import("../src/egress-allowlist");
    const fakeFetch: typeof globalThis.fetch = () =>
      Promise.resolve(okResponse());
    const res = await guardedFetch(
      `https://${GOOGLE_TOKEN_HOST}/token`,
      { method: "POST" },
      { fetch: fakeFetch }
    );
    expect(res.status).toBe(200);
  });

  test("a host not on the allowlist throws and audits, without calling fetch", async () => {
    const { guardedFetch } = await import("../src/egress-allowlist");
    const denied: string[] = [];
    let fetchCalled = false;
    const fakeFetch: typeof globalThis.fetch = () => {
      fetchCalled = true;
      return Promise.resolve(okResponse());
    };
    await expect(
      guardedFetch(
        `https://${OFF_LIST_HOST}/steal`,
        {},
        { audit: (host: string) => denied.push(host), fetch: fakeFetch }
      )
    ).rejects.toThrow(EGRESS_DENIED_RE);
    expect(denied).toContain(OFF_LIST_HOST);
    expect(fetchCalled).toBe(false);
  });

  test("a non-https scheme to an allowlisted OAuth host throws (scheme check)", async () => {
    const { guardedFetch } = await import("../src/egress-allowlist");
    const fakeFetch: typeof globalThis.fetch = () =>
      Promise.resolve(okResponse());
    await expect(
      guardedFetch(
        `http://${GITHUB_OAUTH_HOST}/login/oauth/access_token`,
        {},
        { fetch: fakeFetch }
      )
    ).rejects.toThrow(EGRESS_DENIED_RE);
  });

  test("an allowlisted OAuth host that redirects off-list is rejected on the re-validated hop", async () => {
    const { guardedFetch } = await import("../src/egress-allowlist");
    const fakeFetch: typeof globalThis.fetch = (input) => {
      const href = typeof input === "string" ? input : (input as URL).href;
      if (new URL(href).hostname === GITHUB_OAUTH_HOST) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: `https://${OFF_LIST_HOST}/exfiltrate` },
          })
        );
      }
      return Promise.resolve(okResponse());
    };
    await expect(
      guardedFetch(
        `https://${GITHUB_OAUTH_HOST}/login/oauth/access_token`,
        {},
        { fetch: fakeFetch }
      )
    ).rejects.toThrow(EGRESS_DENIED_RE);
  });
});
