// Acceptance — the pre-auth sign-in surface must not reveal account existence or
// verification state, on the REAL ingress.
//
// better-auth answers a registered-but-unverified account with `403
// EMAIL_NOT_VERIFIED` and an unregistered email / wrong password with `401` — a
// raw enumeration leak (the two diverge, and the 403 confirms the email is
// registered). The production worker normalizer collapses every pre-auth sign-in
// failure to ONE invalid-credentials shape, while a genuine verified-account
// success still issues a real session. Driven through the production
// `auth.handler` + `normalizeAuthResponse`, never a synthetic double.

import {
  resetAuthHarness,
  seedEmailMatrix,
  signInNormalized,
  signInRaw,
} from "@perry-starter/auth/test-harness";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const PASSWORD = "correct horse battery";
const WRONG_PASSWORD = "definitely not the password";
const HTTP_OK = 200;

const UNREGISTERED = "unregistered@matrix.example.com";
const UNVERIFIED = "unverified@matrix.example.com";
const VERIFIED = "verified@matrix.example.com";

interface SurfaceResponse {
  body: unknown;
  headers: Record<string, string>;
  status: number;
}

const canonicalize = (response: SurfaceResponse): string => {
  const headerEntries = Object.entries(response.headers)
    .map(([k, v]) => [k.toLowerCase(), v] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    body: response.body,
    headers: headerEntries,
    status: response.status,
  });
};

beforeEach(async () => {
  // Materialize the divergent accounts: verified@ is signed up AND email-verified;
  // unverified@ is signed up but left unverified; unregistered@ never exists.
  await seedEmailMatrix([
    "registered",
    "unregistered",
    "verified",
    "unverified",
  ]);
});

afterEach(() => {
  resetAuthHarness();
});

describe("the raw sign-in surface leaks registered-vs-unregistered (the defect)", () => {
  test("an unverified account answers 403 while an unregistered email answers 401", async () => {
    const unverified = await signInRaw(UNVERIFIED, PASSWORD);
    const unregistered = await signInRaw(UNREGISTERED, PASSWORD);
    // The raw responses diverge and the unverified case reveals the state token.
    expect(unverified.status).not.toBe(unregistered.status);
    expect(
      JSON.stringify(unverified.body ?? null)
        .toUpperCase()
        .includes("EMAIL_NOT_VERIFIED")
    ).toBe(true);
  });
});

describe("the normalized sign-in surface reveals neither existence nor state", () => {
  test("unregistered, registered-unverified, and wrong-password collapse to one response", async () => {
    const unregistered = await signInNormalized(UNREGISTERED, PASSWORD);
    const unverified = await signInNormalized(UNVERIFIED, PASSWORD);
    const wrongPassword = await signInNormalized(VERIFIED, WRONG_PASSWORD);
    expect(canonicalize(unverified)).toBe(canonicalize(unregistered));
    expect(canonicalize(wrongPassword)).toBe(canonicalize(unregistered));
  });

  test("no normalized failure response leaks EMAIL_NOT_VERIFIED", async () => {
    const unverified = await signInNormalized(UNVERIFIED, PASSWORD);
    expect(
      JSON.stringify(unverified.body ?? null)
        .toUpperCase()
        .includes("EMAIL_NOT_VERIFIED")
    ).toBe(false);
  });

  test("a verified account with the correct password still gets a real session", async () => {
    const success = await signInNormalized(VERIFIED, PASSWORD);
    expect(success.status).toBe(HTTP_OK);
    expect((success.body as { token?: unknown }).token).toBeTruthy();
  });
});
