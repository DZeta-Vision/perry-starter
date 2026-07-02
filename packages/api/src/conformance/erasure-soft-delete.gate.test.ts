// GDPR erasure conformance gate (the P0) — SOFT-delete only, step-up single-use +
// per-action, session-safe.
//
// It drives the REAL mounted `erasure.requestErasure` through the shipped
// `appRouter`, with the REAL forwarder-backed erasure sink over a FAKE forwarder
// that captures every SurrealQL statement. It proves:
//   1. an erasure with NO step-up grant is CHALLENGED (STEP_UP_REQUIRED) and writes
//      nothing — no soft-delete, no registry, no audit;
//   2. a PRIOR grant minted for a DIFFERENT action (role.change) does NOT satisfy
//      the erasure action — it is rejected cross-action, still STEP_UP_REQUIRED;
//   3. a FRESH valid `user.erasure` grant lets the request through, and the only
//      account write is a SOFT-delete UPDATE (isSoftDeleteSql, zero DELETE/REMOVE)
//      plus an additive registry UPSERT — never a hard delete;
//   4. a granted grant is SINGLE-USE: replaying the SAME token is rejected;
//   5. the session is NEVER revoked on the challenge, the cross-action rejection, or
//      the fail-twice abort (revokeSession stays untouched).
//
// The mutation twin (erasure-soft-delete.mutation.test.ts) feeds the SAME pure
// soft-delete checker a hard-delete statement and asserts it reddens — proving the
// "never a hard delete" assertion is load-bearing.

import { createStepUpGrantStore } from "@perry-starter/auth/step-up-store";
import type { SqlResult } from "@perry-starter/data/surreal-http";
import { TRPCError } from "@trpc/server";
import { expect, test, vi } from "vitest";

import type { AdminForward } from "../admin-sinks";
import { isRegistrationOnlySql } from "../crypto-shred-registry";
import { makeErasureSink, USER_ERASURE_ACTION } from "../erasure";
import { appRouter } from "../routers/index";
import { isSoftDeleteSql } from "../user-admin";

const SUBJECT = "user-erase-1";
const SESSION_ID = "sess-erase-1";
const UPDATE_RE = /\bUPDATE\b/i;
const UPSERT_RE = /\bUPSERT\b/i;
const HARD_DELETE_RE = /\b(?:DELETE|REMOVE)\b/i;
const NOW = Date.parse("2026-07-02T09:00:00.000Z");

// A forwarder that captures every statement (so the gate inspects the real SurrealQL
// the mounted procedure would run) and records it on the shared timeline; returns an
// empty OK result.
const capturingForward =
  (calls: string[], timeline: string[]): AdminForward =>
  (query) => {
    calls.push(query);
    timeline.push(`forward:${query}`);
    return Promise.resolve([{ result: [], status: "OK" }] as SqlResult[]);
  };

interface CtxParts {
  readonly forwarded: string[];
  readonly recordConsequentAudit: ReturnType<typeof vi.fn>;
  readonly recordLockoutFailure: ReturnType<typeof vi.fn>;
  readonly revokeSession: ReturnType<typeof vi.fn>;
  readonly store: ReturnType<typeof createStepUpGrantStore>;
  // A single ordered log of audit events AND forwarded statements, so the gate can
  // assert the erasure-requested audit precedes the soft-delete write.
  readonly timeline: string[];
}

const makeParts = (): CtxParts => {
  const timeline: string[] = [];
  return {
    forwarded: [],
    recordConsequentAudit: vi.fn((event: { action: string }) => {
      timeline.push(`audit:${event.action}`);
      return Promise.resolve();
    }),
    recordLockoutFailure: vi.fn(),
    revokeSession: vi.fn(),
    store: createStepUpGrantStore(),
    timeline,
  };
};

const ctxFor = (parts: CtxParts, token: string | undefined) => {
  const sink = makeErasureSink(
    capturingForward(parts.forwarded, parts.timeline)
  );
  return {
    now: NOW,
    recordConsequentAudit: parts.recordConsequentAudit,
    recordLockoutFailure: parts.recordLockoutFailure,
    recordStepUpAudit: vi.fn(() => Promise.resolve()),
    registerShredSubject: sink.registerShredSubject,
    revokeSession: parts.revokeSession,
    session: { id: SESSION_ID, user: { id: SUBJECT, role: "member" } },
    softDeleteForErasure: sink.softDeleteForErasure,
    stepUpStore: parts.store,
    stepUpToken: token,
  };
};

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

test("erasure with no step-up grant is challenged and writes nothing (no soft-delete, no registry, no audit)", async () => {
  const parts = makeParts();
  const caller = appRouter.createCaller(ctxFor(parts, undefined) as never);
  expect(await dataCode(() => caller.erasure.requestErasure())).toBe(
    "STEP_UP_REQUIRED"
  );
  expect(parts.forwarded).toEqual([]);
  expect(parts.recordConsequentAudit).not.toHaveBeenCalled();
  // The challenge NEVER revokes the session.
  expect(parts.revokeSession).not.toHaveBeenCalled();
});

test("a prior grant for a DIFFERENT action does not satisfy erasure (cross-action rejection, session untouched)", async () => {
  const parts = makeParts();
  // A grant minted for role.change — a different dangerous action.
  const foreignToken = parts.store.issue({
    action: "role.change",
    now: NOW,
    sessionId: SESSION_ID,
  });
  const caller = appRouter.createCaller(ctxFor(parts, foreignToken) as never);
  expect(await dataCode(() => caller.erasure.requestErasure())).toBe(
    "STEP_UP_REQUIRED"
  );
  // No account/registry write happened on the cross-action rejection.
  expect(parts.forwarded).toEqual([]);
  // The rejection routes through the shared lockout seam but NEVER the session.
  expect(parts.recordLockoutFailure).toHaveBeenCalledWith(SUBJECT);
  expect(parts.revokeSession).not.toHaveBeenCalled();
});

test("a fresh valid grant soft-deletes (UPDATE, never DELETE) + registers the shred subject + audits", async () => {
  const parts = makeParts();
  const token = parts.store.issue({
    action: USER_ERASURE_ACTION,
    now: NOW,
    sessionId: SESSION_ID,
  });
  const caller = appRouter.createCaller(ctxFor(parts, token) as never);
  const result = await caller.erasure.requestErasure();
  expect(result).toEqual({ erased: true, recoverable: true });

  // Exactly two statements: the soft-delete UPDATE and the registry UPSERT.
  expect(parts.forwarded).toHaveLength(2);
  const softDelete = parts.forwarded.find((q) => UPDATE_RE.test(q)) ?? "";
  const register = parts.forwarded.find((q) => UPSERT_RE.test(q)) ?? "";
  // The account write is a SOFT delete — never a hard DELETE/REMOVE.
  expect(isSoftDeleteSql(softDelete)).toBe(true);
  expect(softDelete).not.toMatch(HARD_DELETE_RE);
  expect(softDelete).toContain("deletedAt");
  expect(softDelete).toContain("erasureRequestedAt");
  // The registry write is additive-only (never a delete).
  expect(isRegistrationOnlySql(register)).toBe(true);
  // The erasure event is audited on the immutable log.
  expect(parts.recordConsequentAudit).toHaveBeenCalledWith({
    action: "user.erasure_requested",
    actor: SUBJECT,
    target: SUBJECT,
  });
  // The erasure-REQUESTED audit is written BEFORE the soft-delete write, and the
  // COMPLETION audit after — so a mid-sequence write failure can never leave a
  // soft-deleted account that was never audited (request-then-completion ordering).
  const requestedIdx = parts.timeline.indexOf("audit:user.erasure_requested");
  const softDeleteIdx = parts.timeline.findIndex(
    (entry) => entry.startsWith("forward:") && UPDATE_RE.test(entry)
  );
  const completedIdx = parts.timeline.indexOf("audit:user.erasure_completed");
  expect(requestedIdx).toBeGreaterThanOrEqual(0);
  expect(softDeleteIdx).toBeGreaterThan(requestedIdx);
  expect(completedIdx).toBeGreaterThan(softDeleteIdx);
  // A successful, session-safe erasure never revokes the session.
  expect(parts.revokeSession).not.toHaveBeenCalled();
});

test("the step-up grant is single-use: replaying the same token is rejected", async () => {
  const parts = makeParts();
  const token = parts.store.issue({
    action: USER_ERASURE_ACTION,
    now: NOW,
    sessionId: SESSION_ID,
  });
  const first = appRouter.createCaller(ctxFor(parts, token) as never);
  await first.erasure.requestErasure(); // consumes the grant

  // A second request presenting the SAME (now consumed) token is rejected.
  const replayParts = makeParts();
  // Re-use the ORIGINAL store so the consumed grant is seen as spent.
  const replayCtx = ctxFor({ ...replayParts, store: parts.store }, token);
  const second = appRouter.createCaller(replayCtx as never);
  expect(await dataCode(() => second.erasure.requestErasure())).toBe(
    "STEP_UP_REQUIRED"
  );
  // No second soft-delete ran on the replay.
  expect(replayParts.forwarded).toEqual([]);
  expect(replayParts.revokeSession).not.toHaveBeenCalled();
});

test("a fail-twice abort never revokes the session (only the action is aborted)", async () => {
  const parts = makeParts();
  // Two rejections in a row for (session, user.erasure): each presents a bogus token.
  const c1 = appRouter.createCaller(ctxFor(parts, "bogus-a") as never);
  expect(await dataCode(() => c1.erasure.requestErasure())).toBe(
    "STEP_UP_REQUIRED"
  );
  const c2 = appRouter.createCaller(
    ctxFor({ ...parts, forwarded: [] }, "bogus-b") as never
  );
  expect(await dataCode(() => c2.erasure.requestErasure())).toBe(
    "STEP_UP_REQUIRED"
  );
  // Even past the fail-twice ceiling, the session is NEVER revoked.
  expect(parts.revokeSession).not.toHaveBeenCalled();
});
