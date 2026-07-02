// Step-up coverage gate for the user-admin router — every dangerous mutation on
// the admin user-management surface (role change + deactivate) is step-up-guarded.
//
// A build-time STRUCTURAL guard: it PROBES the shipped user-admin router by calling
// each declared dangerous procedure with NO grant and asserting it yields
// STEP_UP_REQUIRED — proving it is genuinely guarded — and asserts the guarded set
// matches the manifest so the manifest can never silently drift from the router. It
// also proves the gate is non-vacuous: with a fresh valid grant the guarded mutation
// actually runs. The mutation twin (user-admin-step-up.mutation.test.ts) drives the
// SAME pure guard against a user-admin dangerous action on the plain tier and
// asserts a violation.

import { createStepUpGrantStore } from "@perry-starter/auth/step-up-store";
import { TRPCError } from "@trpc/server";
import { expect, test } from "vitest";

import { findUnguardedDangerousActions } from "../step-up-registry";
import {
  createUserAdminCaller,
  USER_ADMIN_STEP_UP_PROCEDURES,
  type UserAdminContext,
} from "../user-admin";

const T0 = 7_000_000;

const probeCtx = (over: Partial<UserAdminContext> = {}): UserAdminContext => ({
  listUsers: () => Promise.resolve([]),
  now: T0,
  recordConsequentAudit: () => undefined,
  recordLockoutFailure: () => undefined,
  recordStepUpAudit: () => undefined,
  revokeSession: () => undefined,
  revokeUserSessions: () => Promise.resolve(),
  session: { id: "sess-1", user: { id: "user-1", role: "superadmin" } },
  setUserRole: () => Promise.resolve(),
  setUserStatus: () => Promise.resolve(),
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

type ProcName = keyof typeof USER_ADMIN_STEP_UP_PROCEDURES;
const dangerousProcNames = Object.keys(
  USER_ADMIN_STEP_UP_PROCEDURES
) as ProcName[];

const probeCaller = () =>
  createUserAdminCaller(probeCtx()) as unknown as Record<
    ProcName,
    () => Promise<unknown>
  >;

test("the user-admin dangerous-action set covers role change and deactivate", () => {
  expect(Object.values(USER_ADMIN_STEP_UP_PROCEDURES)).toContain("role.change");
  expect(Object.values(USER_ADMIN_STEP_UP_PROCEDURES)).toContain("user.ban");
});

test("every wired user-admin dangerous procedure is step-up-guarded (no grant -> STEP_UP_REQUIRED)", async () => {
  for (const procName of dangerousProcNames) {
    const caller = probeCaller();
    expect(await dataCode(() => caller[procName]())).toBe("STEP_UP_REQUIRED");
  }
});

test("no wired user-admin dangerous action is left on a non-step-up tier", async () => {
  const manifest: Record<string, "step-up" | "protected"> = {};
  for (const procName of dangerousProcNames) {
    const caller = probeCaller();
    const guarded =
      (await dataCode(() => caller[procName]())) === "STEP_UP_REQUIRED";
    manifest[USER_ADMIN_STEP_UP_PROCEDURES[procName]] = guarded
      ? "step-up"
      : "protected";
  }
  expect(findUnguardedDangerousActions(manifest)).toEqual([]);
});

test("the gate is non-vacuous: a fresh valid grant lets the guarded role change run", async () => {
  const store = createStepUpGrantStore();
  const token = store.issue({
    action: "role.change",
    now: T0,
    sessionId: "sess-1",
  });
  const caller = createUserAdminCaller(
    probeCtx({ stepUpStore: store, stepUpToken: token })
  );
  await expect(
    caller.changeRole({ role: "member", targetUserId: "user-2" })
  ).resolves.toMatchObject({ changed: true });
});

test("the gate is non-vacuous: a fresh valid grant lets the guarded deactivate run", async () => {
  const store = createStepUpGrantStore();
  const token = store.issue({
    action: "user.ban",
    now: T0,
    sessionId: "sess-1",
  });
  const caller = createUserAdminCaller(
    probeCtx({ stepUpStore: store, stepUpToken: token })
  );
  await expect(
    caller.deactivateUser({ targetUserId: "user-2" })
  ).resolves.toMatchObject({ deactivated: true });
});
