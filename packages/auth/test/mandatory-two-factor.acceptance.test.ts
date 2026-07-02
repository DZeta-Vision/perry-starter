// Acceptance — the mandatory-2FA entry chain and the TOTP secret at rest.
//
// The chain (PASSWORD_CHANGE_REQUIRED -> forced TOTP enrol -> allow) is ordered
// and non-dismissable, so no admin/superadmin can operate without 2FA and cannot
// skip a step. The TOTP secret is proven ENCRYPTED AT REST (never stored in
// plaintext). The real code-derivation is spike-gated — driven through a
// controllable verifier seam with a deterministic code.

import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpEnvelopeKey,
  generateTotpSecret,
  verifyTotpCode,
} from "@perry-starter/auth/totp-secret";
import {
  CHANGE_PASSWORD_PATH,
  evaluateCredentialChain,
  nextCredentialGate,
  requiresMandatoryTwoFactor,
  TWO_FACTOR_CHALLENGE_PATH,
  TWO_FACTOR_ENROL_PATH,
} from "@perry-starter/auth/two-factor-enrolment";
import { describe, expect, test } from "vitest";

const PRIVILEGED_PATHS = [
  "documents.list",
  "admin.listUsers",
  "organization.setActive",
] as const;

describe("mandatory TOTP is required for every admin/superadmin, not for a member", () => {
  test("admin and superadmin require mandatory 2FA; member does not", () => {
    expect(requiresMandatoryTwoFactor("admin")).toBe(true);
    expect(requiresMandatoryTwoFactor("superadmin")).toBe(true);
    expect(requiresMandatoryTwoFactor("member")).toBe(false);
    // A multi-role claim resolves through the matrix (comma-split).
    expect(requiresMandatoryTwoFactor("admin,member")).toBe(true);
  });
});

describe("the credential chain is ordered and non-dismissable", () => {
  test("while a password change is owed, even an enrolled admin is gated on the password step FIRST", () => {
    const input = {
      requirePasswordChange: true,
      roleClaim: "admin",
      twoFactorEnrolled: true,
    };
    expect(nextCredentialGate(input)).toBe("PASSWORD_CHANGE_REQUIRED");
    // Only change-password is open; the 2FA forward paths are NOT reachable yet.
    expect(
      evaluateCredentialChain({ ...input, path: CHANGE_PASSWORD_PATH }).allow
    ).toBe(true);
    expect(
      evaluateCredentialChain({ ...input, path: TWO_FACTOR_ENROL_PATH }).allow
    ).toBe(false);
  });

  test("an admin/superadmin who has NOT enrolled 2FA cannot reach a privileged op — only the enrol/challenge path is open", () => {
    for (const roleClaim of ["admin", "superadmin"]) {
      const input = {
        requirePasswordChange: false,
        roleClaim,
        twoFactorEnrolled: false,
      };
      expect(nextCredentialGate(input)).toBe("TWO_FACTOR_REQUIRED");
      for (const path of PRIVILEGED_PATHS) {
        const verdict = evaluateCredentialChain({ ...input, path });
        expect(verdict.allow).toBe(false);
        expect(verdict.gate).toBe("TWO_FACTOR_REQUIRED");
      }
      // The forced-enrolment forward paths ARE open (never a dead-end).
      expect(
        evaluateCredentialChain({ ...input, path: TWO_FACTOR_ENROL_PATH }).allow
      ).toBe(true);
      expect(
        evaluateCredentialChain({ ...input, path: TWO_FACTOR_CHALLENGE_PATH })
          .allow
      ).toBe(true);
    }
  });

  test("an enrolled admin with no owed password change is allowed to operate; a member is never 2FA-gated", () => {
    expect(
      nextCredentialGate({
        requirePasswordChange: false,
        roleClaim: "admin",
        twoFactorEnrolled: true,
      })
    ).toBe("ALLOW");
    expect(
      nextCredentialGate({
        requirePasswordChange: false,
        roleClaim: "member",
        twoFactorEnrolled: false,
      })
    ).toBe("ALLOW");
  });
});

describe("the TOTP secret is encrypted at rest", () => {
  test("the sealed envelope never contains the raw secret bytes and round-trips only under its key", async () => {
    const secret = generateTotpSecret();
    const key = await generateTotpEnvelopeKey();
    const envelope = await encryptTotpSecret(secret, key);

    // The stored ciphertext is not the plaintext secret.
    expect(Array.from(envelope.ciphertext)).not.toEqual(Array.from(secret));
    // It opens back to the exact secret under the right key.
    const opened = await decryptTotpSecret(envelope, key);
    expect(Array.from(opened)).toEqual(Array.from(secret));

    // A different key cannot open it (GCM authentication rejects it).
    const otherKey = await generateTotpEnvelopeKey();
    await expect(decryptTotpSecret(envelope, otherKey)).rejects.toBeDefined();
  });

  test("the controllable verifier accepts the current code and rejects a wrong one", () => {
    const secret = generateTotpSecret();
    const verifier = { currentCodeFor: () => "424242" };
    expect(verifyTotpCode(secret, "424242", verifier)).toBe(true);
    expect(verifyTotpCode(secret, "000000", verifier)).toBe(false);
  });
});
