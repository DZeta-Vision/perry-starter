// Audit fail-closed gate — a privileged admin mutation cannot mutate without its
// immutable-audit event wired.
//
// The asymmetric fail-OPEN this closes: on the served surface the SurrealDB data
// sinks fail CLOSED (`requireSink`), but the audit recorders used to be optional-
// chained (`ctx.recordConsequentAudit?.(...)`), so a real role-change / deactivate
// could mutate data yet silently NO-OP its audit when the recorder was unwired. This
// gate PROBES the shipped `appRouter` with a fully-authorized (superadmin) session and
// a fresh, valid step-up grant and asserts that when a required audit sink is ABSENT
// the mutation FAILS CLOSED (ADMIN_BACKEND_UNAVAILABLE) and never runs the data
// mutation — for both the consequent-audit recorder and the step-up audit recorder.
// It also proves the guard is non-vacuous: with BOTH the data sink and the audit
// recorder present the mutation runs AND writes its consequent audit event, and the
// forwarder-backed recorders append a schema-valid event through the ONE shared
// `writeAudit` forwarder. The mutation twin (admin-audit-fail-closed.mutation.test.ts)
// drives a FAIL-OPEN (optional-chaining no-op) audit guard and asserts the throw-
// requirement reddens on it.

import { createStepUpGrantStore } from "@perry-starter/auth/step-up-store";
import type { SqlResult } from "@perry-starter/data/surreal-http";
import { TRPCError } from "@trpc/server";
import { expect, test, vi } from "vitest";

import {
  type AdminForward,
  makeAdminSinks,
  makeAuditRecorders,
} from "../admin-sinks";
import type { Context } from "../context";
import { ADMIN_BACKEND_UNAVAILABLE } from "../fail-closed";
import { appRouter } from "../routers/index";

const SUPERADMIN: Context["session"] = {
  id: "sess-1",
  user: { id: "user-1", role: "superadmin" },
};
const TARGET = "user-2";

// A fresh store carrying a valid `user.ban` grant bound to (sess-1, user.ban), so the
// step-up gate passes and control reaches the fail-closed audit-sink check.
const withBanGrant = (): {
  store: ReturnType<typeof createStepUpGrantStore>;
  token: string;
} => {
  const store = createStepUpGrantStore();
  const token = store.issue({
    action: "user.ban",
    now: 1,
    sessionId: "sess-1",
  });
  return { store, token };
};

const causeCode = async (run: () => Promise<unknown>): Promise<string> => {
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

test("a privileged mutation with the DATA sink present but the CONSEQUENT-audit recorder ABSENT fails closed and never mutates", async () => {
  const { store, token } = withBanGrant();
  const setUserStatus = vi.fn(() => Promise.resolve());
  // Data + step-up audit wired; the consequent-audit recorder is ABSENT.
  const ctx: Context = {
    now: 1,
    recordStepUpAudit: () => undefined,
    revokeUserSessions: vi.fn(() => Promise.resolve()),
    session: SUPERADMIN,
    setUserStatus,
    stepUpStore: store,
    stepUpToken: token,
  };
  const caller = appRouter.createCaller(ctx);
  expect(
    await causeCode(() =>
      caller.userAdmin.deactivateUser({ targetUserId: TARGET })
    )
  ).toBe(ADMIN_BACKEND_UNAVAILABLE);
  // The soft flip NEVER ran — no mutate-then-silently-skip-audit.
  expect(setUserStatus).not.toHaveBeenCalled();
});

test("a privileged mutation with the DATA sink present but the STEP-UP audit recorder ABSENT fails closed and never mutates", async () => {
  const { store, token } = withBanGrant();
  const setUserStatus = vi.fn(() => Promise.resolve());
  // Data + consequent audit wired; the step-up audit recorder is ABSENT.
  const ctx: Context = {
    now: 1,
    recordConsequentAudit: () => undefined,
    revokeUserSessions: vi.fn(() => Promise.resolve()),
    session: SUPERADMIN,
    setUserStatus,
    stepUpStore: store,
    stepUpToken: token,
  };
  const caller = appRouter.createCaller(ctx);
  expect(
    await causeCode(() =>
      caller.userAdmin.deactivateUser({ targetUserId: TARGET })
    )
  ).toBe(ADMIN_BACKEND_UNAVAILABLE);
  expect(setUserStatus).not.toHaveBeenCalled();
});

test("with BOTH the data sink and the audit recorder present, the mutation runs and writes its consequent audit event", async () => {
  const { store, token } = withBanGrant();
  const setUserStatus = vi.fn(() => Promise.resolve());
  const recordConsequentAudit = vi.fn(() => Promise.resolve());
  const ctx: Context = {
    now: 1,
    recordConsequentAudit,
    recordStepUpAudit: () => undefined,
    revokeUserSessions: vi.fn(() => Promise.resolve()),
    session: SUPERADMIN,
    setUserStatus,
    stepUpStore: store,
    stepUpToken: token,
  };
  const caller = appRouter.createCaller(ctx);
  await expect(
    caller.userAdmin.deactivateUser({ targetUserId: TARGET })
  ).resolves.toEqual({ deactivated: true });
  expect(setUserStatus).toHaveBeenCalledWith({
    status: "deactivated",
    userId: TARGET,
  });
  // The consequent audit fires with the right action/actor/target.
  expect(recordConsequentAudit).toHaveBeenCalledWith({
    action: "admin.user_deactivated",
    actor: "user-1",
    target: TARGET,
  });
});

test("the forwarder-backed recorders append a schema-valid consequent + step-up event through the ONE shared writeAudit forwarder", async () => {
  const forwarded: Array<{ query: string; vars?: Record<string, string> }> = [];
  const forward: AdminForward = (query, vars) => {
    forwarded.push({ query, vars });
    return Promise.resolve([{ result: [], status: "OK" }] as SqlResult[]);
  };
  // Built on the SAME forwarder-backed writeAudit sink the data sinks share.
  const sinks = makeAdminSinks(forward);
  const { recordConsequentAudit, recordStepUpAudit } = makeAuditRecorders(
    sinks.writeAudit,
    {
      email: "admin@example.com",
      ip: "127.0.0.1",
      role: "superadmin",
      userAgent: "UA",
    }
  );

  await recordConsequentAudit({
    action: "admin.role_change",
    actor: "user-1",
    target: "user-2",
  });
  await recordStepUpAudit({
    action: "role.change",
    actor: "user-1",
    outcome: "granted",
  });

  // Each recorder forwarded an append-only CREATE into audit_log (never an
  // UPDATE/DELETE), with the arbitrary-byte fields bound as $vars.
  expect(forwarded).toHaveLength(2);
  expect(forwarded[0]?.query).toContain("CREATE type::record('audit_log'");
  expect(forwarded[0]?.vars).toMatchObject({
    action: "admin.role_change",
    actor: "user-1",
    actor_email: "admin@example.com",
    actor_role: "superadmin",
    target_id: "user-2",
    target_type: "user",
  });
  // The step-up attempt maps onto the `auth.step_up_<outcome>` vocabulary action.
  expect(forwarded[1]?.vars).toMatchObject({
    action: "auth.step_up_granted",
    actor: "user-1",
  });
});
