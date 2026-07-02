// Behavior tests for the admin user-management surface: the escalation authority
// (no mint-superadmin / no self-target / no above-tier / non-superadmin), the
// step-up + both-surface target revocation + audit on a role change, the reversible
// (soft) deactivate + reactivate + revocation, and the index-backed keyset builder
// shape. Names describe behavior, not a planning id.

import { createStepUpGrantStore } from "@perry-starter/auth/step-up-store";
import { TRPCError } from "@trpc/server";
import { expect, test, vi } from "vitest";

import {
  buildDeactivateSql,
  buildReactivateSql,
  buildUserListKeysetSql,
  createUserAdminCaller,
  evaluateRoleAssignment,
  isKeysetUserListRead,
  isSoftDeleteSql,
  mapUserListRow,
  REVOCATION_SURFACES,
  type UserAdminContext,
} from "./user-admin";

const T0 = 5_000_000;

const HARD_DELETE_RE = /\b(?:DELETE|REMOVE)\b/i;
const ORDER_DESC_RE = /ORDER BY created_at DESC/;
const LIMIT_25_RE = /LIMIT 25/;
const OFFSET_START_RE = /\b(?:OFFSET|START)\b/i;

const makeCtx = (over: Partial<UserAdminContext> = {}): UserAdminContext => ({
  listUsers: () => Promise.resolve([]),
  now: T0,
  recordConsequentAudit: vi.fn(),
  recordLockoutFailure: vi.fn(),
  recordStepUpAudit: vi.fn(),
  revokeSession: vi.fn(),
  revokeUserSessions: vi.fn(() => Promise.resolve()),
  session: {
    id: "sess-super",
    user: { id: "user-super", role: "superadmin" },
  },
  setUserRole: vi.fn(() => Promise.resolve()),
  setUserStatus: vi.fn(() => Promise.resolve()),
  stepUpStore: createStepUpGrantStore(),
  stepUpToken: undefined,
  ...over,
});

const dataCode = async (run: () => Promise<unknown>): Promise<string> => {
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

// --- The escalation authority (superadmin-only role assignment) --------------

test("a superadmin can demote another user to admin or member", () => {
  for (const role of ["admin", "member"] as const) {
    expect(
      evaluateRoleAssignment({
        actorRole: "superadmin",
        actorUserId: "user-super",
        requestedRole: role,
        targetUserId: "user-other",
      })
    ).toBe("ok");
  }
});

test("the API cannot mint a second superadmin", () => {
  expect(
    evaluateRoleAssignment({
      actorRole: "superadmin",
      actorUserId: "user-super",
      requestedRole: "superadmin",
      targetUserId: "user-other",
    })
  ).toBe("forbidden-escalation");
});

test("a superadmin cannot target its own row", () => {
  expect(
    evaluateRoleAssignment({
      actorRole: "superadmin",
      actorUserId: "user-super",
      requestedRole: "member",
      targetUserId: "user-super",
    })
  ).toBe("forbidden-self-target");
});

test("a non-superadmin (admin or member) cannot assign any role", () => {
  for (const actorRole of ["admin", "member", "admin,member"] as const) {
    expect(
      evaluateRoleAssignment({
        actorRole,
        actorUserId: "user-actor",
        requestedRole: "member",
        targetUserId: "user-other",
      })
    ).toBe("forbidden-not-superadmin");
  }
});

test("an out-of-vocabulary requested role is rejected", () => {
  expect(
    evaluateRoleAssignment({
      actorRole: "superadmin",
      actorUserId: "user-super",
      requestedRole: "owner",
      targetUserId: "user-other",
    })
  ).toBe("invalid-role");
});

// --- The role-change procedure (step-up + both-surface revoke) ---------------

test("a non-superadmin role-change call is FORBIDDEN and never reaches step-up", async () => {
  const ctx = makeCtx({
    session: { id: "sess-admin", user: { id: "user-admin", role: "admin" } },
  });
  const caller = createUserAdminCaller(ctx);
  expect(
    await dataCode(() =>
      caller.changeRole({ role: "member", targetUserId: "user-other" })
    )
  ).toBe("FORBIDDEN");
  // Denied at the role gate BEFORE the step-up challenge — no step-up audit fires.
  expect(ctx.recordStepUpAudit).not.toHaveBeenCalled();
  expect(ctx.setUserRole).not.toHaveBeenCalled();
});

test("a superadmin role change with no grant returns STEP_UP_REQUIRED and does not mutate", async () => {
  const ctx = makeCtx();
  const caller = createUserAdminCaller(ctx);
  expect(
    await dataCode(() =>
      caller.changeRole({ role: "admin", targetUserId: "user-other" })
    )
  ).toBe("STEP_UP_REQUIRED");
  expect(ctx.setUserRole).not.toHaveBeenCalled();
  expect(ctx.revokeUserSessions).not.toHaveBeenCalled();
});

test("a fresh grant runs the role change, revokes the target across both surfaces, and audits admin.role_change", async () => {
  const store = createStepUpGrantStore();
  const token = store.issue({
    action: "role.change",
    now: T0,
    sessionId: "sess-super",
  });
  const ctx = makeCtx({ stepUpStore: store, stepUpToken: token });
  const caller = createUserAdminCaller(ctx);

  await expect(
    caller.changeRole({ role: "admin", targetUserId: "user-other" })
  ).resolves.toEqual({ changed: true, status: "role-changed" });

  expect(ctx.setUserRole).toHaveBeenCalledWith({
    role: "admin",
    userId: "user-other",
  });
  expect(ctx.revokeUserSessions).toHaveBeenCalledWith({
    surfaces: REVOCATION_SURFACES,
    userId: "user-other",
  });
  // Both surfaces are covered.
  expect(REVOCATION_SURFACES).toEqual(["cloud", "local"]);
  expect(ctx.recordConsequentAudit).toHaveBeenCalledWith({
    action: "admin.role_change",
    actor: "user-super",
    target: "user-other",
  });
  // The actor's own session is never revoked by the target revocation.
  expect(ctx.revokeSession).not.toHaveBeenCalled();
});

test("a valid grant that attempts to mint a superadmin is rejected and never mutates", async () => {
  const store = createStepUpGrantStore();
  const token = store.issue({
    action: "role.change",
    now: T0,
    sessionId: "sess-super",
  });
  const ctx = makeCtx({ stepUpStore: store, stepUpToken: token });
  const caller = createUserAdminCaller(ctx);
  expect(
    await dataCode(() =>
      caller.changeRole({ role: "superadmin", targetUserId: "user-other" })
    )
  ).toBe("ROLE_ASSIGNMENT_FORBIDDEN");
  expect(ctx.setUserRole).not.toHaveBeenCalled();
  expect(ctx.revokeUserSessions).not.toHaveBeenCalled();
});

test("a consumed (replayed) grant re-challenges and the role change does not run", async () => {
  const store = createStepUpGrantStore();
  const token = store.issue({
    action: "role.change",
    now: T0,
    sessionId: "sess-super",
  });
  const ctx = makeCtx({ stepUpStore: store, stepUpToken: token });
  const caller = createUserAdminCaller(ctx);
  await caller.changeRole({ role: "admin", targetUserId: "user-other" });
  const setRole = ctx.setUserRole as ReturnType<typeof vi.fn>;
  setRole.mockClear();
  // Re-presenting the same (now consumed) token re-challenges.
  expect(
    await dataCode(() =>
      caller.changeRole({ role: "admin", targetUserId: "user-other" })
    )
  ).toBe("STEP_UP_REQUIRED");
  expect(setRole).not.toHaveBeenCalled();
});

// --- The reversible deactivate (soft flip + both-surface revoke) -------------

test("a deactivate with no grant returns STEP_UP_REQUIRED", async () => {
  const ctx = makeCtx();
  const caller = createUserAdminCaller(ctx);
  expect(
    await dataCode(() => caller.deactivateUser({ targetUserId: "user-other" }))
  ).toBe("STEP_UP_REQUIRED");
  expect(ctx.setUserStatus).not.toHaveBeenCalled();
});

test("a fresh grant soft-deactivates, revokes the target both surfaces, and audits — never a hard delete", async () => {
  const store = createStepUpGrantStore();
  const token = store.issue({
    action: "user.ban",
    now: T0,
    sessionId: "sess-super",
  });
  const ctx = makeCtx({ stepUpStore: store, stepUpToken: token });
  const caller = createUserAdminCaller(ctx);

  await expect(
    caller.deactivateUser({ targetUserId: "user-other" })
  ).resolves.toEqual({ deactivated: true });

  expect(ctx.setUserStatus).toHaveBeenCalledWith({
    status: "deactivated",
    userId: "user-other",
  });
  expect(ctx.revokeUserSessions).toHaveBeenCalledWith({
    surfaces: REVOCATION_SURFACES,
    userId: "user-other",
  });
  expect(ctx.recordConsequentAudit).toHaveBeenCalledWith({
    action: "admin.user_deactivated",
    actor: "user-super",
    target: "user-other",
  });
});

test("an admin cannot deactivate their own row (no self-lockout)", async () => {
  const store = createStepUpGrantStore();
  const token = store.issue({
    action: "user.ban",
    now: T0,
    sessionId: "sess-admin",
  });
  const ctx = makeCtx({
    session: { id: "sess-admin", user: { id: "user-admin", role: "admin" } },
    stepUpStore: store,
    stepUpToken: token,
  });
  const caller = createUserAdminCaller(ctx);
  expect(
    await dataCode(() => caller.deactivateUser({ targetUserId: "user-admin" }))
  ).toBe("FORBIDDEN");
  expect(ctx.setUserStatus).not.toHaveBeenCalled();
});

test("reactivate restores access and audits, with no session revoke", async () => {
  const ctx = makeCtx({
    session: { id: "sess-admin", user: { id: "user-admin", role: "admin" } },
  });
  const caller = createUserAdminCaller(ctx);
  await expect(
    caller.reactivateUser({ targetUserId: "user-other" })
  ).resolves.toEqual({ reactivated: true });
  expect(ctx.setUserStatus).toHaveBeenCalledWith({
    status: "active",
    userId: "user-other",
  });
  expect(ctx.recordConsequentAudit).toHaveBeenCalledWith({
    action: "admin.user_reactivated",
    actor: "user-admin",
    target: "user-other",
  });
  expect(ctx.revokeUserSessions).not.toHaveBeenCalled();
});

test("the deactivate builder is a soft UPDATE, never a hard delete; reactivate flips it back", () => {
  const deactivate = buildDeactivateSql("user-other");
  expect(deactivate.query).toContain("UPDATE");
  expect(deactivate.query).toContain("status = 'deactivated'");
  expect(deactivate.query).not.toMatch(HARD_DELETE_RE);
  expect(isSoftDeleteSql(deactivate.query)).toBe(true);
  expect(deactivate.vars).toEqual({ id: "user-other" });

  const reactivate = buildReactivateSql("user-other");
  expect(reactivate.query).toContain("status = 'active'");
  expect(isSoftDeleteSql(reactivate.query)).toBe(true);
});

test("the deactivate builder rejects an unsafe record-id key", () => {
  expect(() => buildDeactivateSql("user other; DELETE user")).toThrow();
});

// --- The keyset list read (index-backed, no OFFSET) --------------------------

test("a member cannot read the user list (admin-gated)", async () => {
  const ctx = makeCtx({
    session: { id: "sess-m", user: { id: "user-m", role: "member" } },
  });
  const caller = createUserAdminCaller(ctx);
  expect(await dataCode(() => caller.listUsers({ limit: 10 }))).toBe(
    "FORBIDDEN"
  );
});

test("an admin reads the keyset page through the injected forwarder", async () => {
  const users = [
    {
      created_at: "2026-07-02T10:00:00.000Z",
      email: "a@example.com",
      id: "user-a",
      role: "member" as const,
      status: "active" as const,
    },
  ];
  const ctx = makeCtx({
    listUsers: () => Promise.resolve(users),
    session: { id: "sess-admin", user: { id: "user-admin", role: "admin" } },
  });
  const caller = createUserAdminCaller(ctx);
  await expect(caller.listUsers({ limit: 10 })).resolves.toEqual({ users });
});

test("the keyset builder orders + limits with a cursor bound and never uses OFFSET/START", () => {
  const { query, vars } = buildUserListKeysetSql({
    cursor: "2026-07-02T10:00:00.000Z",
    limit: 25,
    status: "active",
  });
  expect(query).toMatch(ORDER_DESC_RE);
  expect(query).toMatch(LIMIT_25_RE);
  expect(query).toContain("created_at < type::datetime($cursor)");
  expect(query).not.toMatch(OFFSET_START_RE);
  expect(isKeysetUserListRead(query)).toBe(true);
  expect(vars).toMatchObject({
    cursor: "2026-07-02T10:00:00.000Z",
    status: "active",
  });
  // The projection never leaks the credential hash.
  expect(query).not.toContain("pass");
});

test("the keyset builder binds role/status/inviter/search filters as vars", () => {
  const { query, vars } = buildUserListKeysetSql({
    invitedBy: "user-inviter",
    limit: 50,
    role: "admin",
    search: "ada",
    status: "deactivated",
  });
  expect(query).toContain("role = $role");
  expect(query).toContain("status = $status");
  expect(query).toContain("invited_by = $invited_by");
  expect(query).toContain("string::contains(email, $search)");
  expect(vars).toEqual({
    invited_by: "user-inviter",
    role: "admin",
    search: "ada",
    status: "deactivated",
  });
});

test("mapUserListRow extracts the bare id and validates against the projection", () => {
  const entry = mapUserListRow({
    created_at: "2026-07-02T10:00:00.000Z",
    email: "a@example.com",
    id: "user:user-a",
    role: "member",
    status: "active",
  });
  expect(entry.id).toBe("user-a");
  expect(entry.email).toBe("a@example.com");
  expect(entry.status).toBe("active");
});
