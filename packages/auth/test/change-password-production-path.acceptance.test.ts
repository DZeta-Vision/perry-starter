// Acceptance — the change-password HIBP + NIST guarantees proven on the REAL
// ingress (better-auth `auth.handler` over an in-memory adapter), never a
// synthetic double:
//
//   - the new password is HIBP-screened on the `newPassword` field — a breached
//     newPassword is rejected when the range API is reachable;
//   - on a range-API outage the SAME breached newPassword is accepted (fail-OPEN)
//     and records the fallback audit, so an HIBP outage never bricks the
//     only-unblocked action for a rotation-required account;
//   - a clean NIST-valid newPassword succeeds (the screen is not vacuously
//     rejecting everything);
//   - the NIST 800-63B length floor applies to change-password too — an 11-char
//     newPassword is rejected.
//
// Each proof signs up, verifies the email, then signs in to obtain the bearer the
// /change-password route authenticates with — the exact post-verify path the
// worker fronts.

import {
  createTestAuthority,
  resetAuthHarness,
} from "@perry-starter/auth/test-harness";
import { afterEach, describe, expect, test } from "vitest";

const HTTP_OK = 200;
// The fixture the reachable HIBP double reports as breached (12 chars — NIST-valid
// on length, so it reaches the breach screen rather than the length gate).
const BREACHED_PASSWORD = "password1234";
const CURRENT_PASSWORD = "correct horse battery";
const CLEAN_NEW_PASSWORD = "fresh staple unicorn";
const TOO_SHORT_NEW_PASSWORD = "a".repeat(11);

// Sign up, verify the email, sign in, and return the session bearer the
// /change-password route requires.
const verifiedSessionToken = async (
  authority: ReturnType<typeof createTestAuthority>,
  email: string
): Promise<string> => {
  await authority.signUp({ email, password: CURRENT_PASSWORD });
  const verifyToken = authority.sentEmails().at(-1)?.variables
    .verifyToken as string;
  await authority.verifyEmail(verifyToken);
  const session = await authority.signIn({ email, password: CURRENT_PASSWORD });
  const token = session.token;
  if (typeof token !== "string") {
    throw new Error("no session token was issued at the post-verify sign-in");
  }
  return token;
};

afterEach(() => {
  resetAuthHarness();
});

describe("the change-password new password is HIBP-screened and fails open on an outage", () => {
  test("a breached newPassword is rejected when the range API is reachable", async () => {
    const authority = createTestAuthority();
    const sessionToken = await verifiedSessionToken(
      authority,
      "change-reachable@example.com"
    );
    const attempt = await authority.changePassword({
      currentPassword: CURRENT_PASSWORD,
      newPassword: BREACHED_PASSWORD,
      sessionToken,
    });
    expect(attempt.status).not.toBe(HTTP_OK);
    expect(JSON.stringify(attempt.body)).toContain("PASSWORD_COMPROMISED");
  });

  test("the same breached newPassword is accepted with an audit event when the range API is unreachable", async () => {
    const authority = createTestAuthority();
    const sessionToken = await verifiedSessionToken(
      authority,
      "change-unreachable@example.com"
    );
    const accepted = await authority.withUnreachableHibp(() =>
      authority.changePassword({
        currentPassword: CURRENT_PASSWORD,
        newPassword: BREACHED_PASSWORD,
        sessionToken,
      })
    );
    expect(accepted.status).toBe(HTTP_OK);
    expect(authority.auditActions()).toContain("auth.hibp_fallback");
  });
});

describe("change-password enforces the NIST 800-63B length floor and accepts a clean password", () => {
  test("a clean NIST-valid newPassword succeeds", async () => {
    const authority = createTestAuthority();
    const sessionToken = await verifiedSessionToken(
      authority,
      "change-clean@example.com"
    );
    const changed = await authority.changePassword({
      currentPassword: CURRENT_PASSWORD,
      newPassword: CLEAN_NEW_PASSWORD,
      sessionToken,
    });
    expect(changed.status).toBe(HTTP_OK);
  });

  test("an 11-char newPassword is rejected (the length floor runs on change too)", async () => {
    const authority = createTestAuthority();
    const sessionToken = await verifiedSessionToken(
      authority,
      "change-short@example.com"
    );
    const tooShort = await authority.changePassword({
      currentPassword: CURRENT_PASSWORD,
      newPassword: TOO_SHORT_NEW_PASSWORD,
      sessionToken,
    });
    expect(tooShort.status).not.toBe(HTTP_OK);
  });
});
