// The hard-delete block — TWO distinct protections keep the destructive hard delete
// and impersonation unreachable. They are NOT the same mechanism; conflating them
// would ship a false guarantee.
//
// GDPR erasure in this system is SOFT-delete + scheduled crypto-shred (recoverable
// until the deferred shred), so no path may hard-delete or impersonate a user.
//
//   (1) SELF-SERVICE `/delete-user` (+ `/delete-user/callback`): better-auth invokes
//       `user.deleteUser.beforeDelete` on this path BEFORE `internalAdapter.deleteUser`,
//       so `blockHardDelete()` below THROWS and interrupts the self-initiated hard
//       delete before any row is removed. This is exactly what `beforeDelete` covers.
//
//   (2) ADMIN `/admin/remove-user` + `/admin/impersonate-user`: these BYPASS
//       `beforeDelete` entirely (better-auth calls `internalAdapter.deleteUser` /
//       mints an impersonation session directly). They are withheld INSTEAD by the
//       ACCESS-CONTROL permission gap: the `user` ac statement / `roleGrants` in the
//       auth config grant NO `delete` and NO `impersonate` action, and the admin
//       plugin's bypass surfaces (`adminUserIds`, `allowImpersonatingAdmins`) are
//       unset — so `hasPermission({ user: ['delete'] })` / `({ user: ['impersonate'] })`
//       denies both endpoints. The structural checkers below prove that gap so a
//       future change that adds one of those actions (or sets `adminUserIds`) reddens.
//
// The thrown error carries HARD_DELETE_WITHHELD in shape.data.code (it is not a
// native code) and a locale-keyed message; the surface renders the generic
// withheld copy, never a stack or internal reason.

import { APIError } from "better-auth/api";

// The precise code carried when a hard delete is refused — distinct from a
// validation or authorization error.
export const HARD_DELETE_WITHHELD_CODE = "HARD_DELETE_WITHHELD";

// The locale key the surface resolves for the refusal copy (never a raw string).
export const HARD_DELETE_WITHHELD_MESSAGE = "auth.error.hard_delete_withheld";

// Block the SELF-SERVICE hard delete: throw an APIError so better-auth interrupts the
// `/delete-user` pipeline before removing the user/sessions/accounts. Wired into
// `user.deleteUser.beforeDelete`. This covers ONLY the self-service path — the admin
// paths are withheld by the permission gap the checkers below assert. Ignores its
// args (the block is unconditional).
export const blockHardDelete = (): never => {
  throw new APIError("BAD_REQUEST", {
    code: HARD_DELETE_WITHHELD_CODE,
    message: HARD_DELETE_WITHHELD_MESSAGE,
  });
};

// --- Structural proof of the ADMIN-PATH permission gap ---------------------------
//
// The admin hard-delete/impersonate paths are withheld ONLY while the access-control
// config grants no dangerous action AND no admin bypass is enabled. These pure
// checkers let the gate assert exactly that against the REAL exported auth config,
// and let the mutation twin prove they redden the moment a dangerous action / bypass
// is added. They read plain data (the statement map + role grants + the admin option
// flags), never better-auth internals.

// `delete` is dangerous on the `user` resource (a user hard-delete); `impersonate`
// (and `impersonate-admins`) is dangerous on ANY resource. `document:delete` is a
// document op, NOT a user hard-delete, so it is safe and must not trip the checker.
const isHardDeleteOrImpersonateAction = (
  resource: string,
  action: string
): boolean =>
  action === "impersonate" ||
  action === "impersonate-admins" ||
  (resource === "user" && action === "delete");

// The shape of an access-control config the gate reads: the statement actions map
// plus the per-role grant maps. Both are plain `{ resource: actions[] }` objects.
export interface AccessControlConfig {
  readonly roleGrants: Readonly<
    Record<string, Readonly<Record<string, readonly string[]>>>
  >;
  readonly statement: Readonly<Record<string, readonly string[]>>;
}

// True iff the statement OR any role grant exposes a user-hard-delete or impersonate
// capability. The gate asserts this is FALSE on the real config (the permission gap
// is intact); the twin asserts it flips TRUE once such an action is added.
export const grantsHardDeleteOrImpersonate = (
  config: AccessControlConfig
): boolean => {
  const scan = (map: Readonly<Record<string, readonly string[]>>): boolean =>
    Object.entries(map).some(([resource, actions]) =>
      actions.some((action) =>
        isHardDeleteOrImpersonateAction(resource, action)
      )
    );
  if (scan(config.statement)) {
    return true;
  }
  return Object.values(config.roleGrants).some((grant) => scan(grant));
};

// The admin() option flags that would OPEN an admin-path bypass: a non-empty
// `adminUserIds` (the `hasPermission` short-circuit that returns true for a listed
// id, bypassing the role check), `allowImpersonatingAdmins`, or an
// `impersonationSessionDuration` (enabling the impersonation surface). The gate
// asserts this is FALSE on the real admin options; the twin asserts it flips TRUE
// once any is set.
export interface AdminBypassOptions {
  readonly adminUserIds?: readonly unknown[];
  readonly allowImpersonatingAdmins?: unknown;
  readonly impersonationSessionDuration?: unknown;
}

export const enablesAdminBypassOrImpersonation = (
  options: AdminBypassOptions
): boolean =>
  (Array.isArray(options.adminUserIds) && options.adminUserIds.length > 0) ||
  options.allowImpersonatingAdmins === true ||
  options.impersonationSessionDuration !== undefined;
