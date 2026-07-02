// Mutation twin for the hard-delete-block gate — proves the withheld checks are
// load-bearing, not decorative.
//
// It feeds the SAME checkers the gate relies on known-bad inputs and asserts each
// goes RED, with the REAL exported config as the green control:
//   - a deleteUser config with NO beforeDelete leaves the self-service hard delete
//     reachable;
//   - the REAL access-control config is clean, but ADDING a `user:delete` or
//     `user:impersonate` action to it flips `grantsHardDeleteOrImpersonate` to true —
//     proving the gate guards the actual permission gap, not a string;
//   - the REAL admin options are clean, but setting `adminUserIds` /
//     `allowImpersonatingAdmins` / `impersonationSessionDuration` flips
//     `enablesAdminBypassOrImpersonation` to true.
// The real block's throw is proven by importing it here.

import { expect, test } from "vitest";

import {
  blockHardDelete,
  enablesAdminBypassOrImpersonation,
  grantsHardDeleteOrImpersonate,
  HARD_DELETE_WITHHELD_CODE,
} from "./hard-delete-block";

interface AuthConfig {
  readonly adminPluginOptions: {
    readonly adminUserIds?: readonly unknown[];
    readonly allowImpersonatingAdmins?: unknown;
    readonly impersonationSessionDuration?: unknown;
  };
  readonly roleGrants: Record<string, Record<string, readonly string[]>>;
  readonly statement: Record<string, readonly string[]>;
}

const loadAuth = async (): Promise<AuthConfig> =>
  (await import("@perry-starter/auth")) as unknown as AuthConfig;

const withheldCodeOf = (thrown: () => unknown): string | undefined => {
  try {
    thrown();
  } catch (error) {
    return (error as { body?: { code?: string } }).body?.code;
  }
  return;
};

// The wired-block detector: a deleteUser config blocks a hard delete iff its
// beforeDelete throws. A config with no beforeDelete does NOT block.
interface DeleteUserConfig {
  readonly beforeDelete?: () => unknown;
}
const blocksHardDelete = (config: DeleteUserConfig): boolean => {
  const before = config.beforeDelete;
  if (typeof before !== "function") {
    return false;
  }
  try {
    before();
  } catch {
    return true;
  }
  return false;
};

test("a deleteUser config with NO beforeDelete block leaves the self-service hard delete reachable (reddens)", () => {
  expect(blocksHardDelete({})).toBe(false);
  // Green control: a config wiring the real block DOES block.
  expect(blocksHardDelete({ beforeDelete: () => blockHardDelete() })).toBe(
    true
  );
});

test("the block throws the withheld code (the delete is refused, not silently allowed)", () => {
  expect(withheldCodeOf(blockHardDelete)).toBe(HARD_DELETE_WITHHELD_CODE);
});

test("adding a user:delete action to the REAL config reddens the permission-gap checker", async () => {
  const { statement, roleGrants } = await loadAuth();
  // Green control: the shipped config has the gap intact.
  expect(grantsHardDeleteOrImpersonate({ statement, roleGrants })).toBe(false);
  // A future change that grants the admin tier `user:delete` opens the admin
  // remove-user bypass — the checker must catch it.
  const withUserDelete = {
    statement: { ...statement, user: [...statement.user, "delete"] },
    roleGrants: {
      ...roleGrants,
      superadmin: {
        ...roleGrants.superadmin,
        user: [...(roleGrants.superadmin?.user ?? []), "delete"],
      },
    },
  };
  expect(grantsHardDeleteOrImpersonate(withUserDelete)).toBe(true);
});

test("adding a user:impersonate action to the REAL config reddens the permission-gap checker", async () => {
  const { statement, roleGrants } = await loadAuth();
  const withImpersonate = {
    statement: { ...statement, user: [...statement.user, "impersonate"] },
    roleGrants: {
      ...roleGrants,
      admin: {
        ...roleGrants.admin,
        user: [...(roleGrants.admin?.user ?? []), "impersonate"],
      },
    },
  };
  expect(grantsHardDeleteOrImpersonate(withImpersonate)).toBe(true);
});

test("setting an admin bypass surface reddens the admin-option checker", async () => {
  const { adminPluginOptions } = await loadAuth();
  // Green control: the shipped admin options wire no bypass.
  expect(enablesAdminBypassOrImpersonation(adminPluginOptions)).toBe(false);
  // Each bypass surface, added, must redden.
  expect(
    enablesAdminBypassOrImpersonation({
      ...adminPluginOptions,
      adminUserIds: ["user-root"],
    })
  ).toBe(true);
  expect(
    enablesAdminBypassOrImpersonation({
      ...adminPluginOptions,
      allowImpersonatingAdmins: true,
    })
  ).toBe(true);
  expect(
    enablesAdminBypassOrImpersonation({
      ...adminPluginOptions,
      impersonationSessionDuration: 3600,
    })
  ).toBe(true);
});
