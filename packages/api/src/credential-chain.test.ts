// The mandatory-2FA credential-chain middleware — an admin/superadmin cannot
// reach a privileged op until the ordered chain (password change -> forced TOTP
// enrol) is satisfied; a member is never 2FA-gated.

import { TRPCError } from "@trpc/server";
import { describe, expect, test } from "vitest";
import { createCredentialChainCaller } from "./index";

const session = (over: {
  role: string;
  requirePasswordChange?: boolean;
  twoFactorEnrolled?: boolean;
}) => ({
  session: {
    user: {
      id: "user-1",
      requirePasswordChange: over.requirePasswordChange ?? false,
      role: over.role,
      twoFactorEnrolled: over.twoFactorEnrolled ?? false,
    },
  },
});

// Pull the precise gate code carried in shape.data.code off a thrown error.
const gateCode = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof TRPCError) {
      const cause = error.cause as { code?: string } | undefined;
      return cause?.code ?? error.code;
    }
  }
  return "no-error";
};

describe("an admin/superadmin cannot skip the credential chain to operate", () => {
  test("an admin who owes a password change is blocked from a privileged op AND from the 2FA step, carrying PASSWORD_CHANGE_REQUIRED", async () => {
    const caller = createCredentialChainCaller(
      session({ requirePasswordChange: true, role: "admin" })
    );
    expect(await gateCode(() => caller.listUsers())).toBe(
      "PASSWORD_CHANGE_REQUIRED"
    );
    // The 2FA forward path is not reachable while a password change is owed.
    expect(await gateCode(() => caller.enrolTwoFactor())).toBe(
      "PASSWORD_CHANGE_REQUIRED"
    );
    // Only change-password is open.
    await expect(caller.changePassword()).resolves.toEqual({ changed: true });
  });

  test("an admin without TOTP is blocked from a privileged op with TWO_FACTOR_REQUIRED, but may enrol/verify", async () => {
    const caller = createCredentialChainCaller(
      session({ role: "admin", twoFactorEnrolled: false })
    );
    expect(await gateCode(() => caller.listUsers())).toBe(
      "TWO_FACTOR_REQUIRED"
    );
    await expect(caller.enrolTwoFactor()).resolves.toEqual({ enrolled: true });
    await expect(caller.verifyTwoFactor()).resolves.toEqual({ verified: true });
  });

  test("an enrolled admin reaches the privileged op; a member is never 2FA-gated", async () => {
    const enrolledAdmin = createCredentialChainCaller(
      session({ role: "admin", twoFactorEnrolled: true })
    );
    await expect(enrolledAdmin.listUsers()).resolves.toEqual({ users: [] });

    const member = createCredentialChainCaller(
      session({ role: "member", twoFactorEnrolled: false })
    );
    await expect(member.listUsers()).resolves.toEqual({ users: [] });
  });

  test("an unauthenticated caller is rejected UNAUTHORIZED", async () => {
    const caller = createCredentialChainCaller({ session: null });
    expect(await gateCode(() => caller.listUsers())).toBe("UNAUTHORIZED");
  });
});
