// Conformance gate — the cloud Worker/relay response wrapper attaches the FULL
// security header set to EVERY response leg: a 2xx success, a thrown error
// (caught → 500), AND a 3xx redirect, with no header dropped on any branch. It
// drives the REAL `withSecurityHeaders` with an injected producer and asserts the
// shared `missingSecurityHeaders` predicate reports nothing on all three legs. It
// also proves the CSP is a genuine per-response nonce-CSP: two responses carry
// DIFFERENT fresh nonces, and a producer that renders an inline `<script nonce>`
// gets the SAME nonce the CSP authorizes. The mutation twin
// (security-headers.mutation.test.ts) drops one header on one branch and asserts
// the SAME predicate reddens — proving this gate is not vacuous.

import {
  cspHasNonce,
  missingSecurityHeaders,
  STATIC_SECURITY_HEADERS,
  TURNSTILE_CHALLENGE_HOST,
} from "@perry-starter/env/security-headers";
import { expect, test } from "vitest";

import { withSecurityHeaders } from "../security-headers";

const CSP_HEADER = "Content-Security-Policy";
const CSP_NONCE_RE = /'nonce-([^']+)'/;
const SCRIPT_NONCE_RE = /<script nonce="([^"]+)"/;

const cspNonceOf = (csp: string | null): string | null =>
  csp?.match(CSP_NONCE_RE)?.[1] ?? null;

const scriptNonceOf = (body: string): string | null =>
  body.match(SCRIPT_NONCE_RE)?.[1] ?? null;

const succeedWith = (status: number, init?: ResponseInit) => () =>
  Promise.resolve(new Response("ok", { status, ...init }));

test("a successful response carries the full header set at the exact mandated values", async () => {
  const res = await withSecurityHeaders(succeedWith(200));

  expect(res.status).toBe(200);
  expect(missingSecurityHeaders(res.headers)).toEqual([]);
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    expect(res.headers.get(name)).toBe(value);
  }
  const csp = res.headers.get(CSP_HEADER);
  expect(csp).toContain(TURNSTILE_CHALLENGE_HOST);
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(cspHasNonce(csp)).toBe(true);
});

test("a thrown error is caught and STILL carries the full header set (as a 500)", async () => {
  const res = await withSecurityHeaders(() =>
    Promise.reject(new Error("boom"))
  );

  expect(res.status).toBe(500);
  expect(missingSecurityHeaders(res.headers)).toEqual([]);
});

test("a 3xx redirect carries the full header set AND preserves its Location", async () => {
  const res = await withSecurityHeaders(
    succeedWith(302, { headers: { location: "/after-login" } })
  );

  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/after-login");
  expect(missingSecurityHeaders(res.headers)).toEqual([]);
});

test("every response gets a FRESH per-response nonce (two responses differ)", async () => {
  const first = await withSecurityHeaders(succeedWith(200));
  const second = await withSecurityHeaders(succeedWith(200));

  const firstNonce = cspNonceOf(first.headers.get(CSP_HEADER));
  const secondNonce = cspNonceOf(second.headers.get(CSP_HEADER));

  expect(firstNonce).toBeTruthy();
  expect(secondNonce).toBeTruthy();
  expect(firstNonce).not.toBe(secondNonce);
});

test("the CSP nonce authorizes THIS response's inline script (same nonce in header and body)", async () => {
  const res = await withSecurityHeaders((nonce) =>
    Promise.resolve(
      new Response(`<script nonce="${nonce}">boot()</script>`, {
        headers: { "content-type": "text/html" },
      })
    )
  );

  const cspNonce = cspNonceOf(res.headers.get(CSP_HEADER));
  const bodyNonce = scriptNonceOf(await res.text());

  expect(cspNonce).toBeTruthy();
  expect(bodyNonce).toBe(cspNonce);
});
