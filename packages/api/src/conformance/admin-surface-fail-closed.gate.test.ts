// Fail-closed gate — a privileged admin procedure reached on a tier with NO
// forwarder throws rather than returning unprivileged data.
//
// The mounted admin surface is served on BOTH the gatekeeper Worker (which injects
// the SurrealDB-backed sinks) and, for the shared router type, any relay tier (which
// injects none). This gate PROBES the SHIPPED `appRouter` with a fully-authorized
// (superadmin) session but NO injected forwarder and asserts each privileged
// procedure fails closed with ADMIN_BACKEND_UNAVAILABLE — proving a missing forwarder
// can never surface an empty-but-authorized page. It also proves the guard is
// non-vacuous: WITH a forwarder-backed sink the SAME read returns data. The mutation
// twin (admin-surface-fail-closed.mutation.test.ts) drives a FAIL-OPEN guard and
// asserts the throw-requirement reddens on it.

import { createStepUpGrantStore } from "@perry-starter/auth/step-up-store";
import type { SqlResult } from "@perry-starter/data/surreal-http";
import { TRPCError } from "@trpc/server";
import { expect, test } from "vitest";

import { makeAdminSinks } from "../admin-sinks";
import type { Context } from "../context";
import { ADMIN_BACKEND_UNAVAILABLE, requireSink } from "../fail-closed";
import { appRouter } from "../routers/index";

const SUPERADMIN: Context["session"] = {
  id: "sess-1",
  user: { id: "user-1", role: "superadmin" },
};

// A canonical audit row the fake forwarder returns for the non-vacuous case.
const AUDIT_ROW = {
  action: "auth.sign_in",
  actor: "user:01J0XQT8Z9N3H6K2M5P7R9T1V3",
  actor_email: "person@example.com",
  actor_role: "member",
  id: "audit_log:01ARZ3NDEKTSV4RRFFQ69G5FAV",
  ip: "127.0.0.1",
  metadata: {},
  target_id: "session:1",
  target_type: "session",
  timestamp: "2026-07-02T08:26:30.607Z",
  user_agent: "UA",
};

// The relay tier: session + step-up store, but NO forwarder-backed sinks.
const noForwarderCtx = (): Context => ({
  now: 1,
  session: SUPERADMIN,
  stepUpStore: createStepUpGrantStore(),
});

// The gatekeeper tier: the same, PLUS the forwarder-backed sinks over a fake
// forwarder (one statement, its result an array — the SurrealDB SELECT shape).
const forwarderCtx = (): Context => ({
  ...noForwarderCtx(),
  ...makeAdminSinks(() =>
    Promise.resolve([{ result: [AUDIT_ROW], status: "OK" }] as SqlResult[])
  ),
});

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

test("requireSink returns the sink when present and throws ADMIN_BACKEND_UNAVAILABLE when absent", () => {
  const sink = () => "ok";
  expect(requireSink(sink, "readAuditEntries")).toBe(sink);
  let thrown: unknown;
  try {
    requireSink(undefined, "readAuditEntries");
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TRPCError);
  expect((thrown as TRPCError).code).toBe("INTERNAL_SERVER_ERROR");
  expect(((thrown as TRPCError).cause as { code?: string }).code).toBe(
    ADMIN_BACKEND_UNAVAILABLE
  );
});

test("a privileged read with NO forwarder fails closed (throws, returns no data)", async () => {
  const caller = appRouter.createCaller(noForwarderCtx());
  expect(await causeCode(() => caller.audit.list({ limit: 50 }))).toBe(
    ADMIN_BACKEND_UNAVAILABLE
  );
  expect(await causeCode(() => caller.userAdmin.listUsers({ limit: 50 }))).toBe(
    ADMIN_BACKEND_UNAVAILABLE
  );
});

test("a privileged mutation with NO forwarder fails closed under a fresh, valid step-up grant", async () => {
  const store = createStepUpGrantStore();
  const token = store.issue({
    action: "user.ban",
    now: 1,
    sessionId: "sess-1",
  });
  // A superadmin with a VALID grant still cannot deactivate without the forwarder —
  // the step-up passes, then the SurrealDB-backed write fails closed.
  const caller = appRouter.createCaller({
    now: 1,
    session: SUPERADMIN,
    stepUpStore: store,
    stepUpToken: token,
  });
  expect(
    await causeCode(() =>
      caller.userAdmin.deactivateUser({ targetUserId: "u2" })
    )
  ).toBe(ADMIN_BACKEND_UNAVAILABLE);
});

test("the fail-closed guard is non-vacuous: WITH the forwarder the same privileged read returns data", async () => {
  const caller = appRouter.createCaller(forwarderCtx());
  const page = await caller.audit.list({ limit: 50 });
  expect(page.entries).toHaveLength(1);
  expect(page.entries[0]?.id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
});
