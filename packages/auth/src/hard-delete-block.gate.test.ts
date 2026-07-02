// Hard-delete-block conformance gate — the destructive hard delete + impersonation
// are UNREACHABLE via TWO distinct, honestly-named protections.
//
// GDPR erasure here is soft-delete + scheduled crypto-shred, so no path may hard-
// delete or impersonate a user. This gate proves BOTH mechanisms, without conflating
// them:
//   1. the block throws HARD_DELETE_WITHHELD (the refusal is a real throw);
//   2. the real better-auth config wires that block into `user.deleteUser.beforeDelete`,
//      so invoking the shipped hook throws — this covers the SELF-SERVICE `/delete-user`
//      path (better-auth runs `beforeDelete` there before removing any row);
//   3. the ADMIN `/admin/remove-user` + `/admin/impersonate-user` paths — which BYPASS
//      `beforeDelete` and instead gate on `hasPermission({ user: ['delete'] })` /
//      `({ user: ['impersonate'] })` — are withheld STRUCTURALLY: the real `statement`
//      / `roleGrants` grant no `delete`/`impersonate` action (the permission gap), and
//      the real `adminPluginOptions` set neither `adminUserIds` nor
//      `allowImpersonatingAdmins`/`impersonationSessionDuration` (no bypass surface).
//
// The structural checks are NOT a grep — they run the pure checkers over the REAL
// exported config values, so adding a `user:delete`/`impersonate` action or an
// `adminUserIds` entry reddens this gate. The mutation twin proves the checkers are
// load-bearing by flipping each on a mutated config.
//
// Collection-safe: the `@perry-starter/auth` singleton is dynamically imported (it
// needs the seeded env); the top-level imports are `vitest` + the pure checkers.

import { expect, test } from "vitest";

import {
  blockHardDelete,
  enablesAdminBypassOrImpersonation,
  grantsHardDeleteOrImpersonate,
  HARD_DELETE_WITHHELD_CODE,
} from "./hard-delete-block";

interface DeleteUserConfig {
  readonly beforeDelete?: (...args: unknown[]) => unknown;
  readonly enabled?: boolean;
}
// The exported access-control + admin-option surfaces the structural gate reads.
interface AuthConfig {
  readonly adminPluginOptions: {
    readonly adminUserIds?: readonly unknown[];
    readonly allowImpersonatingAdmins?: unknown;
    readonly impersonationSessionDuration?: unknown;
  };
  readonly auth: {
    readonly options: {
      readonly user?: { readonly deleteUser?: DeleteUserConfig };
    };
  };
  readonly roleGrants: Readonly<
    Record<string, Readonly<Record<string, readonly string[]>>>
  >;
  readonly statement: Readonly<Record<string, readonly string[]>>;
}

const loadAuth = async (): Promise<AuthConfig> =>
  (await import("@perry-starter/auth")) as unknown as AuthConfig;

// The thrown-error projection: a hard-delete block throws carrying the withheld code.
const withheldCodeOf = (thrown: () => unknown): string | undefined => {
  try {
    thrown();
  } catch (error) {
    return (error as { body?: { code?: string }; status?: string }).body?.code;
  }
  return;
};

test("the hard-delete block throws HARD_DELETE_WITHHELD (the destructive delete is refused)", () => {
  expect(() => blockHardDelete()).toThrow();
  expect(withheldCodeOf(blockHardDelete)).toBe(HARD_DELETE_WITHHELD_CODE);
});

test("the config wires the block into deleteUser.beforeDelete so the SELF-SERVICE hard delete is interrupted", async () => {
  const { auth } = await loadAuth();
  const deleteUser = auth.options.user?.deleteUser;
  expect(deleteUser?.enabled).toBe(true);
  const beforeDelete = deleteUser?.beforeDelete;
  expect(typeof beforeDelete).toBe("function");
  // Invoking the SHIPPED hook throws the withheld code — better-auth runs this on the
  // self-service `/delete-user` path before removing any row, so the self-initiated
  // hard delete is interrupted. (It does NOT run on the admin paths — those are
  // covered by the structural permission-gap assertions below.)
  expect(withheldCodeOf(() => (beforeDelete as () => unknown)())).toBe(
    HARD_DELETE_WITHHELD_CODE
  );
});

test("the admin remove/impersonate paths are withheld by the permission gap — no role grants user:delete or impersonate", async () => {
  const { statement, roleGrants } = await loadAuth();
  // The REAL access-control config grants no user-hard-delete and no impersonate
  // action on any resource — so the admin plugin's `hasPermission({ user:['delete'] })`
  // / `({ user:['impersonate'] })` checks (which gate remove-user/impersonate-user and
  // BYPASS beforeDelete) deny both endpoints.
  expect(grantsHardDeleteOrImpersonate({ statement, roleGrants })).toBe(false);
  // Sanity: the gap is specifically the absence of the dangerous actions, not a
  // missing `user` resource — `user` exists and grants only the safe admin actions.
  expect(statement.user).toContain("list");
  expect(statement.user).not.toContain("delete");
  expect(statement.user).not.toContain("impersonate");
});

test("the admin bypass surfaces are unset — no adminUserIds, no allowImpersonatingAdmins", async () => {
  const { adminPluginOptions } = await loadAuth();
  // Neither the `hasPermission` short-circuit (`adminUserIds`) nor the impersonation
  // surface (`allowImpersonatingAdmins`/`impersonationSessionDuration`) is set, so
  // there is no bypass around the permission gap above.
  expect(enablesAdminBypassOrImpersonation(adminPluginOptions)).toBe(false);
});
