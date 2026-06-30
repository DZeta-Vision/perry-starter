// Red-phase acceptance scaffolds — the post-auth verification wall, verification
// completion, and the device-local pre-auth locale migration.
//
// An authenticated-but-unverified member hitting any protected op is denied
// EMAIL_NOT_VERIFIED (carried in the AD-21 shape.data.code envelope) and held on
// the wall, with a rate-limited resend affordance phrased non-numerically. A valid
// unexpired verification link clears the wall and reaches the dashboard; expired or
// already-consumed tokens are rejected with the SAME neutral copy. The device-local
// pre-auth locale migrates into the account locale on sign-up.
//
// TDD RED phase: every test is `test.skip(...)`. The tRPC caller, the verification
// surface, and the harness are imported dynamically INSIDE skipped bodies; top-level
// imports are limited to vitest. The non-numeric copy detector is real now.

import { describe, expect, test } from "vitest";

// Detects a numeric countdown / "try again in N seconds" phrasing (forbidden).
const NUMERIC_COUNTDOWN = /\d+\s*(seconds?|minutes?|hours?|secs?|mins?|s|m)\b/i;

const isNonNumericCopy = (copy: string): boolean =>
  !NUMERIC_COUNTDOWN.test(copy);

// Future surfaces (dev wires specifiers in green): a tRPC caller bound to a given
// session, plus the verification/locale harness.
const loadApiHarness = async () => {
  const mod = await import("@perry-starter/api/test-harness");
  return mod.createApiHarness() as Promise<{
    callerFor: (session: { emailVerified: boolean }) => {
      protectedOp: () => Promise<unknown>;
      resendVerification: () => Promise<{ copy: string }>;
    };
    rejectionCode: (error: unknown) => string | undefined;
    resendIsRateLimited: (session: {
      emailVerified: boolean;
    }) => Promise<boolean>;
  }>;
};

const loadVerificationHarness = async () => {
  const mod = await import("@perry-starter/auth/test-harness");
  return mod.createVerificationHarness() as Promise<{
    signUp: (input: {
      email: string;
      password: string;
      locale?: string;
    }) => Promise<{
      account: { locale: string };
      verifyToken: string;
      expiredVerifyToken: string;
      sentLocale: string;
    }>;
    verify: (token: string) => Promise<{
      emailVerified: boolean;
      wallCleared: boolean;
      activeOrganizationId: string | null;
      rejectionCopy: string | null;
    }>;
  }>;
};

const VALID_PASSWORD = "correct horse";
const UNVERIFIED_SESSION = { emailVerified: false };
const VERIFIED_SESSION = { emailVerified: true };

// ──────────────────────────────────────────────────────────────────────────────
describe("an unverified member is held on the verification wall on protected ops", () => {
  test("a protected op for an unverified member is denied EMAIL_NOT_VERIFIED", async () => {
    const harness = await loadApiHarness();
    const caller = harness.callerFor(UNVERIFIED_SESSION);
    try {
      await caller.protectedOp();
      throw new Error("expected the protected op to be denied");
    } catch (error) {
      expect(harness.rejectionCode(error)).toBe("EMAIL_NOT_VERIFIED");
    }
  });

  test("a verified member is NOT held on the wall (the wall is not always-on)", async () => {
    const harness = await loadApiHarness();
    const caller = harness.callerFor(VERIFIED_SESSION);
    await expect(caller.protectedOp()).resolves.toBeDefined();
  });

  test("the resend affordance is rate-limited", async () => {
    const harness = await loadApiHarness();
    expect(await harness.resendIsRateLimited(UNVERIFIED_SESSION)).toBe(true);
  });

  test("the resend affordance copy is phrased non-numerically", async () => {
    const harness = await loadApiHarness();
    const caller = harness.callerFor(UNVERIFIED_SESSION);
    const { copy } = await caller.resendVerification();
    expect(isNonNumericCopy(copy)).toBe(true);
  });

  test("the non-numeric copy detector flags a numeric countdown phrasing", () => {
    expect(isNonNumericCopy("Check your inbox to finish signing in.")).toBe(
      true
    );
    expect(isNonNumericCopy("Try again in 30 seconds.")).toBe(false);
    expect(isNonNumericCopy("Please wait 5 min before retrying.")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("verification completion clears the wall; bad tokens reuse the neutral copy", () => {
  test("a valid unexpired token sets emailVerified true and clears the wall", async () => {
    const harness = await loadVerificationHarness();
    const { verifyToken } = await harness.signUp({
      email: "verify@example.com",
      password: VALID_PASSWORD,
    });
    const result = await harness.verify(verifyToken);
    expect(result.emailVerified).toBe(true);
    expect(result.wallCleared).toBe(true);
    expect(result.activeOrganizationId).toBeTruthy();
  });

  test("an expired token is rejected with the same neutral copy as an unknown token", async () => {
    const harness = await loadVerificationHarness();
    const { expiredVerifyToken } = await harness.signUp({
      email: "expired@example.com",
      password: VALID_PASSWORD,
    });
    const expired = await harness.verify(expiredVerifyToken);
    const unknown = await harness.verify("an-unknown-token");
    expect(expired.emailVerified).toBe(false);
    expect(expired.rejectionCopy).toBe(unknown.rejectionCopy);
  });

  test("an already-consumed token cannot be consumed a second time", async () => {
    const harness = await loadVerificationHarness();
    const { verifyToken } = await harness.signUp({
      email: "single-use@example.com",
      password: VALID_PASSWORD,
    });
    await harness.verify(verifyToken);
    const secondConsume = await harness.verify(verifyToken);
    expect(secondConsume.emailVerified).toBe(false);
    const unknown = await harness.verify("an-unknown-token");
    expect(secondConsume.rejectionCopy).toBe(unknown.rejectionCopy);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("a device-local pre-auth locale migrates into the account on sign-up", () => {
  test("a pre-auth fr locale becomes the account locale (not left at the en default)", async () => {
    const harness = await loadVerificationHarness();
    const { account } = await harness.signUp({
      email: "locale-fr@example.com",
      password: VALID_PASSWORD,
      locale: "fr",
    });
    expect(account.locale).toBe("fr");
    expect(account.locale).not.toBe("en");
  });

  test("the verification email is dispatched in the migrated account locale", async () => {
    const harness = await loadVerificationHarness();
    const { sentLocale } = await harness.signUp({
      email: "locale-email@example.com",
      password: VALID_PASSWORD,
      locale: "fr",
    });
    expect(sentLocale).toBe("fr");
  });

  test("an out-of-domain locale is rejected by the constrained locale shape", async () => {
    const harness = await loadVerificationHarness();
    await expect(
      harness.signUp({
        email: "locale-de@example.com",
        password: VALID_PASSWORD,
        locale: "de",
      })
    ).rejects.toBeDefined();
  });
});
