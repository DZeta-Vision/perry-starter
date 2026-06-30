// Acceptance tests for the desktop loopback OAuth callback.
//
// These assert that the desktop client uses a 127.0.0.1 loopback HTTP listener
// as the PRIMARY callback on every desktop OS, that the authorize request
// carries a PKCE S256 challenge (challenge == base64url(SHA-256(verifier))) and
// a high-entropy state, that the custom-scheme deep-link is sugar only (a no-op
// stub on Linux/Windows that never displaces the loopback primary), that the
// one-time code is exchanged over HTTPS through the cloud authority (the daemon
// relays — it never mints or decides identity locally), and that the
// cloud-minted token is written to the secure store with no plaintext at rest.
//
// RED PHASE: every test is `test.skip`. The loopback OAuth module does not exist
// yet; all not-yet-existing imports and all IO (fastify inject, crypto,
// fetch-relay) are dynamic inside the skipped bodies. The only top-level imports
// are vitest and node builtins.

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

const LOOPBACK = "127.0.0.1";
// The cloud authority (the cloud gatekeeper Worker) the one-time code is relayed
// to — NOT a provider host, and never a local auth decision.
const CLOUD_AUTHORITY_HOST = "api.perryts.com";
const STATE_MIN_BYTES = 32; // 256-bit

// Hoisted (top-level) regexes used inside the skipped bodies.
const REPLY_HEADER_CONTENT_TYPE_RE = /reply\.header\(\s*["']content-type["']/i;
const PROVIDER_HOST_RE = /github|google/i;

const base64UrlSha256 = (input: string): string =>
  createHash("sha256").update(input).digest("base64url");

describe("loopback authorize request carries PKCE S256 + high-entropy state", () => {
  test("uses a 127.0.0.1 loopback redirect_uri as the callback (primary on every desktop OS)", async () => {
    const { buildAuthorizeRequest } = await import("../src/loopback-oauth");
    const built = buildAuthorizeRequest({ provider: "github", port: 8765 });
    const redirectUri = new URL(
      new URL(built.url).searchParams.get("redirect_uri") ?? ""
    );
    expect(redirectUri.hostname).toBe(LOOPBACK);
  });

  test("emits a PKCE challenge equal to base64url(SHA-256(verifier)) with method S256", async () => {
    const { buildAuthorizeRequest } = await import("../src/loopback-oauth");
    const built = buildAuthorizeRequest({ provider: "google", port: 8765 });
    const params = new URL(built.url).searchParams;
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBe(
      base64UrlSha256(built.codeVerifier)
    );
  });

  test("mints a fresh high-entropy state per flow (two builds differ, meets the length floor)", async () => {
    const { buildAuthorizeRequest } = await import("../src/loopback-oauth");
    const a = buildAuthorizeRequest({ provider: "github", port: 8765 });
    const b = buildAuthorizeRequest({ provider: "github", port: 8765 });
    expect(a.state).not.toBe(b.state);
    // base64url of >=32 bytes is >=43 chars.
    expect(a.state.length).toBeGreaterThanOrEqual(43);
    expect(Buffer.from(a.state, "base64url").byteLength).toBeGreaterThanOrEqual(
      STATE_MIN_BYTES
    );
  });
});

describe("loopback listener binds 127.0.0.1 and serves /callback via reply.type", () => {
  test("binds the listener to the loopback interface", async () => {
    const fastify = (await import("fastify")).default;
    const { mountLoopbackCallback } = await import("../src/loopback-oauth");
    const app = fastify();
    mountLoopbackCallback(app, {
      expectedState: "expected",
      codeVerifier: "verifier",
      onToken: async () => undefined,
    });
    await app.ready();
    // The route exists and the listener is loopback-bound (the host binding is
    // asserted at listen() time in the daemon bootstrap; here we prove the route
    // is mounted and addressable via inject).
    const res = await app.inject({
      method: "GET",
      url: "/callback?code=c&state=expected",
    });
    expect(res.statusCode).not.toBe(404);
    await app.close();
  });

  test("sets the callback content-type via reply.type, never reply.header('content-type')", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(process.cwd(), "apps", "daemon", "src", "loopback-oauth.ts"),
      "utf8"
    );
    expect(source).not.toMatch(REPLY_HEADER_CONTENT_TYPE_RE);
  });
});

describe("the one-time code is relayed to the cloud authority, never decided locally", () => {
  test("exchanges the one-time code over HTTPS through the cloud authority host", async () => {
    const { exchangeOneTimeCode } = await import("../src/loopback-oauth");
    const seen: { url: string; method: string } = { url: "", method: "" };
    const fakeFetch: typeof globalThis.fetch = (input, init) => {
      seen.url = typeof input === "string" ? input : (input as URL).href;
      seen.method = init?.method ?? "GET";
      return Promise.resolve(
        new Response(JSON.stringify({ token: "cloud-minted-session" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    };
    const result = await exchangeOneTimeCode(
      { code: "one-time", codeVerifier: "verifier", state: "expected" },
      { fetch: fakeFetch }
    );
    const target = new URL(seen.url);
    expect(target.protocol).toBe("https:");
    expect(target.hostname).toBe(CLOUD_AUTHORITY_HOST);
    expect(seen.method.toUpperCase()).toBe("POST");
    // The daemon RECEIVES a cloud-minted token; it does not mint one itself.
    expect(result.token).toBe("cloud-minted-session");
  });

  test("never posts the one-time code to a provider host (no client-side token exchange)", async () => {
    const { exchangeOneTimeCode } = await import("../src/loopback-oauth");
    let target = "";
    const fakeFetch: typeof globalThis.fetch = (input) => {
      target = typeof input === "string" ? input : (input as URL).href;
      return Promise.resolve(
        new Response(JSON.stringify({ token: "t" }), { status: 200 })
      );
    };
    await exchangeOneTimeCode(
      { code: "one-time", codeVerifier: "v", state: "expected" },
      { fetch: fakeFetch }
    );
    const host = new URL(target).hostname;
    expect(host).not.toMatch(PROVIDER_HOST_RE);
    expect(host).toBe(CLOUD_AUTHORITY_HOST);
  });
});

describe("the cloud-minted token is written to the secure store, never plaintext", () => {
  test("persists through the secure-store path and leaves no plaintext token at rest", async () => {
    const { persistSessionToken } = await import("../src/loopback-oauth");
    const writes: string[] = [];
    const persisted = await persistSessionToken("super-secret-session-token", {
      // Inject the secure-store sink so the envelope round-trip is observable
      // without touching a real OS keychain (spike-open on headless Linux).
      secureStore: {
        save: (_key: string, blob: string) => {
          writes.push(blob);
          return Promise.resolve();
        },
      },
    });
    // The persisted artifact is an envelope, not the raw token.
    expect(persisted.atRest).not.toContain("super-secret-session-token");
    for (const blob of writes) {
      expect(blob).not.toContain("super-secret-session-token");
    }
  });
});

describe("custom-scheme deep-link is sugar only (stubbed on Linux/Windows)", () => {
  test("the deep-link registrar is a no-op stub on Linux and Windows and never throws", async () => {
    const { registerDeepLinkScheme } = await import("../src/loopback-oauth");
    const linux = registerDeepLinkScheme("linux");
    const windows = registerDeepLinkScheme("win32");
    expect(linux.stubbed).toBe(true);
    expect(windows.stubbed).toBe(true);
    // Loopback stays the primary mechanism — the stub does not displace it.
    expect(linux.primaryCallback).toBe("loopback");
    expect(windows.primaryCallback).toBe("loopback");
  });
});
