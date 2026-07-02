// Behavior tests for the self-service GDPR erasure module — the soft-delete builder
// tombstones (never a hard delete), the erasure sink forwards a soft UPDATE + a
// registry UPSERT, and the mounted request fails closed when a sink/audit seam is
// unwired (the relay tier).

import { createStepUpGrantStore } from "@perry-starter/auth/step-up-store";
import type { SqlResult } from "@perry-starter/data/surreal-http";
import { expect, test, vi } from "vitest";

import type { AdminForward } from "./admin-sinks";
import { isRegistrationOnlySql } from "./crypto-shred-registry";
import {
  buildErasureSoftDeleteSql,
  makeErasureSink,
  USER_ERASURE_ACTION,
} from "./erasure";
import { ADMIN_BACKEND_UNAVAILABLE } from "./fail-closed";
import { appRouter } from "./routers/index";
import { isSoftDeleteSql } from "./user-admin";

const SUBJECT = "user-42";
const NOW_ISO = "2026-07-02T09:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const HARD_DELETE_RE = /\b(?:DELETE|REMOVE)\b/i;

test("the erasure soft-delete is an UPDATE that stamps the tombstones and never a hard delete", () => {
  const { query, vars } = buildErasureSoftDeleteSql(SUBJECT, NOW_ISO);
  expect(query).toContain("UPDATE");
  expect(query).toContain("SET status = 'deactivated'");
  expect(query).toContain("deletedAt = type::datetime($now)");
  expect(query).toContain("erasureRequestedAt = type::datetime($now)");
  // It is a soft delete: no DELETE/REMOVE anywhere.
  expect(isSoftDeleteSql(query)).toBe(true);
  expect(query).not.toMatch(HARD_DELETE_RE);
  // The subject id + the instant travel as bound $vars, never spliced in.
  expect(vars).toEqual({ id: SUBJECT, now: NOW_ISO });
  expect(query).not.toContain(SUBJECT);
});

test("a safe-id guard rejects a record-id key that could break the type::record target", () => {
  expect(() => buildErasureSoftDeleteSql("bad id;DROP", NOW_ISO)).toThrow();
});

test("the erasure sink forwards a soft-delete UPDATE and a crypto-shred registry UPSERT", async () => {
  const calls: { query: string; vars?: Record<string, string> }[] = [];
  const forward: AdminForward = (query, vars) => {
    calls.push({ query, vars });
    return Promise.resolve([{ result: [], status: "OK" }] as SqlResult[]);
  };
  const sink = makeErasureSink(forward);
  await sink.softDeleteForErasure(SUBJECT, NOW_ISO);
  await sink.registerShredSubject(SUBJECT);

  expect(calls).toHaveLength(2);
  // The soft-delete leg is a tombstone UPDATE (never a hard delete).
  expect(isSoftDeleteSql(calls[0]?.query ?? "")).toBe(true);
  // The registry leg is an additive UPSERT (never a delete).
  expect(isRegistrationOnlySql(calls[1]?.query ?? "")).toBe(true);
  // The registry write carries an independently-generated key handle (not the id).
  expect(calls[1]?.vars?.subject).toBe(SUBJECT);
  expect(calls[1]?.vars?.keyHandle).toBeTypeOf("string");
  expect(calls[1]?.vars?.keyHandle).not.toBe(SUBJECT);
});

const causeCode = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    const cause = (error as { cause?: { code?: string }; code?: string }).cause;
    return cause?.code ?? (error as { code?: string }).code ?? "no-error";
  }
  return "no-error";
};

const grantedCtx = (over: Record<string, unknown> = {}) => {
  const store = createStepUpGrantStore();
  const token = store.issue({
    action: USER_ERASURE_ACTION,
    now: NOW_MS,
    sessionId: "sess-1",
  });
  return {
    now: NOW_MS,
    recordConsequentAudit: vi.fn(() => Promise.resolve()),
    recordLockoutFailure: vi.fn(),
    recordStepUpAudit: vi.fn(() => Promise.resolve()),
    registerShredSubject: vi.fn(() => Promise.resolve()),
    session: { id: "sess-1", user: { id: SUBJECT, role: "member" } },
    softDeleteForErasure: vi.fn(() => Promise.resolve()),
    stepUpStore: store,
    stepUpToken: token,
    ...over,
  };
};

test("on a tier with NO erasure sinks the request fails closed after a valid step-up (never a partial erasure)", async () => {
  // A relay-tier ctx: a valid grant, an audit sink, but the forwarder-backed erasure
  // sinks are absent — the request must throw, never soft-delete-without-registering.
  const ctx = grantedCtx({
    registerShredSubject: undefined,
    softDeleteForErasure: undefined,
  });
  const caller = appRouter.createCaller(ctx as never);
  expect(await causeCode(() => caller.erasure.requestErasure())).toBe(
    ADMIN_BACKEND_UNAVAILABLE
  );
  // No write ran without every seam wired.
  expect(ctx.recordConsequentAudit).not.toHaveBeenCalled();
});

test("with NO audit recorder the erasure fails closed BEFORE any soft-delete (audit is not fail-open)", async () => {
  const ctx = grantedCtx({ recordConsequentAudit: undefined });
  const caller = appRouter.createCaller(ctx as never);
  expect(await causeCode(() => caller.erasure.requestErasure())).toBe(
    ADMIN_BACKEND_UNAVAILABLE
  );
  expect(ctx.softDeleteForErasure).not.toHaveBeenCalled();
  expect(ctx.registerShredSubject).not.toHaveBeenCalled();
});

test("a granted request soft-deletes, registers the shred subject, and audits the erasure", async () => {
  const ctx = grantedCtx();
  const caller = appRouter.createCaller(ctx as never);
  const result = await caller.erasure.requestErasure();

  expect(result).toEqual({ erased: true, recoverable: true });
  expect(ctx.softDeleteForErasure).toHaveBeenCalledWith(SUBJECT, NOW_ISO);
  expect(ctx.registerShredSubject).toHaveBeenCalledWith(SUBJECT);
  expect(ctx.recordConsequentAudit).toHaveBeenCalledWith({
    action: "user.erasure_requested",
    actor: SUBJECT,
    target: SUBJECT,
  });
});
