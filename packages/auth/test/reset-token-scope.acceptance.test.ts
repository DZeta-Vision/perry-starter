// Acceptance — the prior-reset-token invalidation is SCOPED so it never sweeps a
// two-factor / recovery enrolment row.
//
// The reset flow keys its verification row by the bare user id and invalidates any
// PRIOR reset token on re-issue (2-6). Mandatory-2FA enrolment adds a second
// user-keyed verification writer (the enrolment marker), namespaced under
// `two-factor:<userId>`. This proves, on the REAL better-auth authority, that a
// reset-token invalidation leaves the two-factor marker intact — while a prior
// reset token is STILL invalidated (the 2-6 guarantee is preserved).

import {
  isResetScopeValue,
  isTwoFactorScopeValue,
  twoFactorVerificationScope,
} from "@perry-starter/auth/reset-token-scope";
import {
  createTestAuthority,
  resetAuthHarness,
} from "@perry-starter/auth/test-harness";
import { afterEach, describe, expect, test } from "vitest";

const HTTP_OK = 200;
const VALID_PASSWORD = "correct horse battery";
const FRESH_PASSWORD = "fresh staple unicorn";
const SECOND_PASSWORD = "another distinct phrase";

afterEach(() => {
  resetAuthHarness();
});

describe("reset-scope classification", () => {
  test("a bare user id is a reset-scope value; a two-factor namespace value is not", () => {
    expect(isResetScopeValue("user-123")).toBe(true);
    expect(isResetScopeValue(twoFactorVerificationScope("user-123"))).toBe(
      false
    );
    expect(isTwoFactorScopeValue(twoFactorVerificationScope("user-123"))).toBe(
      true
    );
    expect(isResetScopeValue("")).toBe(false);
  });
});

describe("a reset-token invalidation never clobbers a two-factor / recovery enrolment row", () => {
  test("a two-factor enrolment marker survives a subsequent password-reset-token invalidation", async () => {
    const authority = createTestAuthority();
    const email = "twofa-survives@example.com";
    const account = await authority.signUp({ email, password: VALID_PASSWORD });
    await authority.verifyEmail(
      authority.sentEmails().at(-1)?.variables.verifyToken as string
    );
    const userId = account.userId as string;

    // Materialize a two-factor enrolment marker keyed under the two-factor
    // namespace (the second user-keyed verification writer).
    const markerValue = twoFactorVerificationScope(userId);
    authority.seedVerificationRow({
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      identifier: "two-factor-enrol-marker",
      value: markerValue,
    });

    // Issue TWO reset tokens: the second issuance fires the prior-token purge.
    const firstToken = (await authority.requestPasswordReset(email))
      .token as string;
    const secondToken = (await authority.requestPasswordReset(email))
      .token as string;
    expect(firstToken).toBeTruthy();
    expect(secondToken).toBeTruthy();

    // The two-factor marker is STILL present (not swept by the reset purge).
    const marker = authority
      .verificationRows()
      .find((row) => row.value === markerValue);
    expect(marker).toBeTruthy();

    // …and the 2-6 guarantee holds: the PRIOR reset token was invalidated, only
    // the latest resets.
    const stale = await authority.resetPassword({
      newPassword: FRESH_PASSWORD,
      token: firstToken,
    });
    expect(stale.status).not.toBe(HTTP_OK);
    const latest = await authority.resetPassword({
      newPassword: SECOND_PASSWORD,
      token: secondToken,
    });
    expect(latest.status).toBe(HTTP_OK);

    // The two-factor marker is STILL present after the completed reset too.
    expect(
      authority.verificationRows().some((row) => row.value === markerValue)
    ).toBe(true);
  });
});
