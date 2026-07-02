// Behavior tests for the self-scoped data-export module — the read
// builders bind the subject as a $var (injection-safe, owner-scoped), the mounted
// procedure fails closed when its sink/audit seam is unwired (the relay tier), and
// the request input strips any client-supplied subject id.

import type { SqlResult } from "@perry-starter/data/surreal-http";
import { expect, test, vi } from "vitest";

import type { AdminForward } from "./admin-sinks";
import {
  buildAuditExportSql,
  buildDeltasExportSql,
  buildDocumentsExportSql,
  buildProfileExportSql,
  dataExportRequestSchema,
  makeExportSink,
} from "./data-export";
import { ADMIN_BACKEND_UNAVAILABLE } from "./fail-closed";
import { appRouter } from "./routers/index";

const SUBJECT = "user-42";

test("every read builder binds the subject as $userId and never splices it into the body", () => {
  for (const build of [
    buildProfileExportSql,
    buildDocumentsExportSql,
    buildDeltasExportSql,
    buildAuditExportSql,
  ]) {
    const { query, vars } = build(SUBJECT);
    expect(vars).toEqual({ userId: SUBJECT });
    expect(query).toContain("$userId");
    // The subject value itself never appears literally in the statement.
    expect(query).not.toContain(SUBJECT);
  }
});

test("the owned-collection reads are owner-scoped (WHERE on the subject predicate)", () => {
  expect(buildDocumentsExportSql(SUBJECT).query).toContain(
    "WHERE scope_user_id = $userId"
  );
  expect(buildDeltasExportSql(SUBJECT).query).toContain(
    "WHERE scope_user_id = $userId"
  );
  expect(buildAuditExportSql(SUBJECT).query).toContain("WHERE actor = $userId");
  expect(buildProfileExportSql(SUBJECT).query).toContain("WHERE id =");
});

test("the export sink forwards one owner-scoped read per collection", async () => {
  const forward = vi.fn(() =>
    Promise.resolve([{ result: [], status: "OK" }] as SqlResult[])
  );
  const sink = makeExportSink(forward as AdminForward);
  const bundle = await sink.exportUserData(SUBJECT);
  expect(bundle).toEqual({
    audit_trail: [],
    deltas: [],
    documents: [],
    profile: [],
  });
  // Four reads, each carrying the bound subject var.
  expect(forward).toHaveBeenCalledTimes(4);
  for (const call of forward.mock.calls) {
    expect(call[1]).toEqual({ userId: SUBJECT });
  }
});

test("the request schema strips any client-supplied subject id", () => {
  expect(dataExportRequestSchema.parse({ subjectId: "user-b" })).toEqual({});
  expect(dataExportRequestSchema.parse(undefined)).toEqual({});
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

test("on a tier with NO export sink the procedure fails closed (never returns unscoped data)", async () => {
  // The relay tier: session present, but the forwarder-backed export + audit sinks
  // are absent — the export must throw, never silently succeed.
  const ctx = {
    recordConsequentAudit: vi.fn(() => Promise.resolve()),
    session: { id: "s", user: { id: SUBJECT, role: "member" } },
  };
  const caller = appRouter.createCaller(ctx as never);
  expect(await causeCode(() => caller.compliance.exportMyData())).toBe(
    ADMIN_BACKEND_UNAVAILABLE
  );
});

test("with NO audit recorder the export fails closed BEFORE any read (audit is not fail-open)", async () => {
  const exportUserData = vi.fn(() =>
    Promise.resolve({
      audit_trail: [],
      deltas: [],
      documents: [],
      profile: [],
    })
  );
  const ctx = {
    exportUserData,
    session: { id: "s", user: { id: SUBJECT, role: "member" } },
  };
  const caller = appRouter.createCaller(ctx as never);
  expect(await causeCode(() => caller.compliance.exportMyData())).toBe(
    ADMIN_BACKEND_UNAVAILABLE
  );
  // The export read never ran — no dump is produced without its audit leg wired.
  expect(exportUserData).not.toHaveBeenCalled();
});
