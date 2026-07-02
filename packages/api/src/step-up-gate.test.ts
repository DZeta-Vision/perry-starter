// The per-action step-up gate — a dangerous mutation cannot proceed without a
// fresh, single-use, server-verified grant bound to (session, action).
//
// With no grant the gate CHALLENGES (STEP_UP_REQUIRED, in shape.data.code); a fresh
// matching grant lets the mutation run and audits its consequent action; a replayed
// (cross-action) / reused / expired / fabricated grant re-challenges and the
// mutation NEVER runs. A rejected grant records through the shared lockout seam, and
// NO failure/abort path ever revokes the session. Every attempt writes an audit
// event (actor/action/outcome), and a granted mutation writes TWO events.

import { createStepUpGrantStore } from "@perry-starter/auth/step-up-store";
import { TRPCError } from "@trpc/server";
import { describe, expect, test, vi } from "vitest";

import {
  createStepUpCaller,
  type StepUpAuditEvent,
  type StepUpContext,
} from "./index";

const T0 = 2_000_000;
const TTL_MS = 5 * 60 * 1000;

interface CtxOver {
  now?: number;
  session?: StepUpContext["session"];
  stepUpToken?: string;
  store?: ReturnType<typeof createStepUpGrantStore>;
}

const makeCtx = (over: CtxOver = {}) => {
  const audits: StepUpAuditEvent[] = [];
  const consequent: Array<{ actor: string; action: string }> = [];
  const lockout = vi.fn();
  const revokeSession = vi.fn();
  const store = over.store ?? createStepUpGrantStore();
  const ctx: StepUpContext = {
    now: over.now ?? T0,
    recordConsequentAudit: (event) => consequent.push(event),
    recordLockoutFailure: lockout,
    recordStepUpAudit: (event) => audits.push(event),
    revokeSession,
    session:
      "session" in over
        ? (over.session ?? null)
        : { id: "sess-1", user: { id: "user-1", role: "superadmin" } },
    stepUpStore: store,
    stepUpToken: over.stepUpToken,
  };
  return { audits, consequent, ctx, lockout, revokeSession, store };
};

// Pull the precise code carried in shape.data.code off a thrown error.
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

describe("a dangerous mutation requires a fresh, server-verified step-up grant", () => {
  test("with no grant the gate challenges with STEP_UP_REQUIRED and the mutation does not run", async () => {
    const { ctx, consequent, lockout, revokeSession, audits } = makeCtx();
    const caller = createStepUpCaller(ctx);
    expect(await dataCode(() => caller.changeRole())).toBe("STEP_UP_REQUIRED");
    expect(consequent).toHaveLength(0); // the resolver never ran
    expect(lockout).not.toHaveBeenCalled(); // a challenge is not a failure
    expect(revokeSession).not.toHaveBeenCalled(); // the session is untouched
    expect(audits).toEqual([
      { action: "role.change", actor: "user-1", outcome: "challenged" },
    ]);
  });

  test("a fresh matching grant lets the mutation run and audits BOTH the grant and its consequent action", async () => {
    const store = createStepUpGrantStore();
    const token = store.issue({
      action: "role.change",
      now: T0,
      sessionId: "sess-1",
    });
    const { ctx, consequent, audits, revokeSession } = makeCtx({
      store,
      stepUpToken: token,
    });
    const caller = createStepUpCaller(ctx);
    await expect(caller.changeRole()).resolves.toEqual({ changed: true });
    expect(audits).toContainEqual({
      action: "role.change",
      actor: "user-1",
      outcome: "granted",
    });
    expect(consequent).toEqual([
      { action: "admin.role_change", actor: "user-1" },
    ]);
    expect(revokeSession).not.toHaveBeenCalled();
  });

  test("a grant for role.change replayed against invite.create is re-challenged and invite.create does not run", async () => {
    const store = createStepUpGrantStore();
    const token = store.issue({
      action: "role.change",
      now: T0,
      sessionId: "sess-1",
    });
    const { ctx, consequent, lockout, revokeSession } = makeCtx({
      store,
      stepUpToken: token,
    });
    const caller = createStepUpCaller(ctx);
    expect(await dataCode(() => caller.createInvitation())).toBe(
      "STEP_UP_REQUIRED"
    );
    expect(consequent).toHaveLength(0);
    expect(lockout).toHaveBeenCalledWith("user-1"); // recorded through the shared seam
    expect(revokeSession).not.toHaveBeenCalled();
  });

  test("a reused (consumed) grant is re-challenged and the mutation does not run twice", async () => {
    const store = createStepUpGrantStore();
    const token = store.issue({
      action: "role.change",
      now: T0,
      sessionId: "sess-1",
    });
    const { ctx, consequent } = makeCtx({ store, stepUpToken: token });
    const caller = createStepUpCaller(ctx);
    await expect(caller.changeRole()).resolves.toEqual({ changed: true });
    expect(await dataCode(() => caller.changeRole())).toBe("STEP_UP_REQUIRED");
    expect(consequent).toHaveLength(1); // ran exactly once
  });

  test("an expired grant is re-challenged and the mutation does not run", async () => {
    const store = createStepUpGrantStore();
    const token = store.issue({
      action: "role.change",
      now: T0,
      sessionId: "sess-1",
    });
    const { ctx, consequent } = makeCtx({
      now: T0 + TTL_MS,
      store,
      stepUpToken: token,
    });
    const caller = createStepUpCaller(ctx);
    expect(await dataCode(() => caller.changeRole())).toBe("STEP_UP_REQUIRED");
    expect(consequent).toHaveLength(0);
  });

  test("a fabricated token (never minted by the store) is re-challenged — the client cannot assert success", async () => {
    const { ctx, consequent } = makeCtx({
      stepUpToken: "client-made-up-token",
    });
    const caller = createStepUpCaller(ctx);
    expect(await dataCode(() => caller.changeRole())).toBe("STEP_UP_REQUIRED");
    expect(consequent).toHaveLength(0);
  });

  test("failing step-up twice aborts the action but NEVER revokes the session", async () => {
    const { ctx, revokeSession, lockout } = makeCtx({ stepUpToken: "bad" });
    const caller = createStepUpCaller(ctx);
    expect(await dataCode(() => caller.changeRole())).toBe("STEP_UP_REQUIRED");
    expect(await dataCode(() => caller.changeRole())).toBe("STEP_UP_REQUIRED");
    // Both failures recorded through the shared lockout seam; the session is never
    // touched across either failure or the abort.
    expect(lockout).toHaveBeenCalledTimes(2);
    expect(revokeSession).not.toHaveBeenCalled();
  });

  test("every rejected attempt writes an audit event capturing actor/action/outcome", async () => {
    const { ctx, audits } = makeCtx({ stepUpToken: "bad" });
    const caller = createStepUpCaller(ctx);
    await dataCode(() => caller.changeRole());
    expect(audits).toEqual([
      { action: "role.change", actor: "user-1", outcome: "rejected" },
    ]);
  });

  test("an unauthenticated caller is rejected UNAUTHORIZED before any step-up decision", async () => {
    const { ctx, lockout } = makeCtx({ session: null });
    const caller = createStepUpCaller(ctx);
    expect(await dataCode(() => caller.changeRole())).toBe("UNAUTHORIZED");
    expect(lockout).not.toHaveBeenCalled();
  });

  test("a benign, non-dangerous op needs no step-up grant", async () => {
    const { ctx } = makeCtx(); // no token
    const caller = createStepUpCaller(ctx);
    await expect(caller.readSettings()).resolves.toEqual({ settings: [] });
  });
});
