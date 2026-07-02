// Mutation twin for security-headers.gate.test.ts (daemon).
//
// It proves the daemon gate is anti-vacuous by feeding its two trusted predicates
// known-bad input:
//   - `missingSecurityHeaders` MUST report an incomplete set (a dropped header or
//     a CSP that fails to name the Turnstile host), so the gate's `toEqual([])`
//     can genuinely fail;
//   - `cspHasNonce` MUST return true for a nonce'd CSP, so the daemon gate's
//     `toBe(false)` (no-nonce static fallback) can genuinely fail if a per-request
//     nonce ever leaks onto the static shell.
// The good static baseline stays green in both.

import {
  buildContentSecurityPolicy,
  CONTENT_SECURITY_POLICY_HEADER,
  cspHasNonce,
  type HeaderReader,
  missingSecurityHeaders,
  STATIC_SECURITY_HEADERS,
  TURNSTILE_CHALLENGE_HOST,
} from "@perry-starter/env/security-headers";
import { expect, test } from "vitest";

// Build a case-insensitive reader over a plain header record, optionally dropping
// one header or substituting a rogue CSP — modeling a daemon regression.
const readerOf = (
  overrides: { dropHeader?: string; csp?: string | null } = {}
): HeaderReader => {
  const record = new Map<string, string>();
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    if (name !== overrides.dropHeader) {
      record.set(name.toLowerCase(), value);
    }
  }
  const csp =
    overrides.csp === undefined ? buildContentSecurityPolicy() : overrides.csp;
  if (csp !== null) {
    record.set(CONTENT_SECURITY_POLICY_HEADER.toLowerCase(), csp);
  }
  return { get: (name: string) => record.get(name.toLowerCase()) ?? null };
};

test("a dropped static header reddens the completeness predicate", () => {
  const missing = missingSecurityHeaders(
    readerOf({ dropHeader: "Referrer-Policy" })
  );
  expect(missing).toContain("Referrer-Policy");
});

test("a CSP that fails to name the Turnstile host reddens the predicate", () => {
  const missing = missingSecurityHeaders(
    readerOf({ csp: "default-src 'self'; object-src 'none'" })
  );
  expect(missing).toContain(CONTENT_SECURITY_POLICY_HEADER);
});

test("a per-response nonce leaking onto the static shell trips the no-nonce check", () => {
  const nonced = buildContentSecurityPolicy({ nonce: "leaked-nonce" });
  // The gate asserts `cspHasNonce(csp) === false`; a leaked nonce makes it true.
  expect(cspHasNonce(nonced)).toBe(true);
});

test("the good static baseline stays green — full set present, Turnstile named, no nonce", () => {
  const reader = readerOf();
  expect(missingSecurityHeaders(reader)).toEqual([]);
  const csp = reader.get(CONTENT_SECURITY_POLICY_HEADER);
  expect(csp).toContain(TURNSTILE_CHALLENGE_HOST);
  expect(cspHasNonce(csp)).toBe(false);
});
