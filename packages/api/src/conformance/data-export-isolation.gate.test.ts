// Cross-scope isolation gate (the P0) — a subject's data export contains ONLY that
// subject's own records.
//
// It drives the REAL mounted `compliance.exportMyData` procedure through the
// shipped `appRouter`, with the REAL forwarder-backed export sink over a FAKE
// forwarder that holds a MIXED dataset (rows for subject A AND subject B) and
// honors the bound `$userId` var exactly as SurrealDB's `WHERE <owner> = $userId`
// would. Under subject A's session the bundle carries ONLY A's rows and ZERO of
// B's — proving the owner predicate (bound to the SERVER-derived subject), not the
// caller, enforces the scope. It also proves a client-supplied subject id is
// ignored (the scope never widens to B), and that the request + completion are both
// audited.
//
// The mutation twin (data-export-isolation.mutation.test.ts) drives an export sink
// that DROPS the owner predicate (binds no `$userId`) against the SAME fake DB, so
// B's rows leak into the bundle and `bundleForeignRows` goes non-empty — proving
// this gate's zero-foreign-rows assertion is load-bearing.

import type { SqlResult } from "@perry-starter/data/surreal-http";
import { expect, test, vi } from "vitest";

import type { AdminForward } from "../admin-sinks";
import { bundleForeignRows, makeExportSink } from "../data-export";
import { appRouter } from "../routers/index";

type Row = Record<string, unknown>;

const SUBJECT_A = "user-a";
const SUBJECT_B = "user-b";

// A ULID per collection row (Crockford base32, 26 chars).
const DOC_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DOC_B = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const DELTA_A = "01J0XQT8Z9N3H6K2M5P7R9T1V3";
const DELTA_B = "01J0XQT8Z9N3H6K2M5P7R9T1V4";
const AUDIT_A = "01HZ0R5N8Q7M3K2J5P7R9T1V3A";
const AUDIT_B = "01HZ0R5N8Q7M3K2J5P7R9T1V3B";
const B64 = "aGVsbG8="; // valid base64 payload

// A mixed dataset spanning BOTH subjects across every owned collection.
const DATASET: Record<string, Row[]> = {
  audit_log: [
    {
      action: "auth.sign_in",
      actor: SUBJECT_A,
      actor_email: "a@example.com",
      actor_role: "member",
      id: `audit_log:${AUDIT_A}`,
      ip: "127.0.0.1",
      metadata: {},
      target_id: SUBJECT_A,
      target_type: "user",
      timestamp: "2026-07-02T08:26:30.607Z",
      user_agent: "UA",
    },
    {
      action: "auth.sign_in",
      actor: SUBJECT_B,
      actor_email: "b@example.com",
      actor_role: "member",
      id: `audit_log:${AUDIT_B}`,
      ip: "127.0.0.1",
      metadata: {},
      target_id: SUBJECT_B,
      target_type: "user",
      timestamp: "2026-07-02T08:26:30.607Z",
      user_agent: "UA",
    },
  ],
  document_delta: [
    {
      cursor: 1,
      doc_id: DOC_A,
      doc_schema_version: 0,
      id: DELTA_A,
      payload: B64,
      scope_user_id: SUBJECT_A,
    },
    {
      cursor: 1,
      doc_id: DOC_B,
      doc_schema_version: 0,
      id: DELTA_B,
      payload: B64,
      scope_user_id: SUBJECT_B,
    },
  ],
  document_projection: [
    {
      body_preview: "a preview",
      doc_id: DOC_A,
      scope_user_id: SUBJECT_A,
      title: "A doc",
    },
    {
      body_preview: "b preview",
      doc_id: DOC_B,
      scope_user_id: SUBJECT_B,
      title: "B doc",
    },
  ],
  user: [
    {
      email: "a@example.com",
      family_name: "Alpha",
      given_name: "Aa",
      id: `user:${SUBJECT_A}`,
      locale: "en",
      role: "member",
      status: "active",
    },
    {
      email: "b@example.com",
      family_name: "Beta",
      given_name: "Bb",
      id: `user:${SUBJECT_B}`,
      locale: "en",
      role: "member",
      status: "active",
    },
  ],
};

const bareKey = (raw: unknown): string => {
  const value = typeof raw === "string" ? raw : "";
  return value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value;
};

// The owner key per collection — the SAME projection SurrealDB's WHERE clause keys
// on. The fake DB filters by it ONLY when a `$userId` is bound (mirroring a real
// `WHERE <owner> = $userId`); with no bound var it returns the full scan.
const OWNER: Record<string, (row: Row) => string> = {
  audit_log: (row) => String(row.actor),
  document_delta: (row) => String(row.scope_user_id),
  document_projection: (row) => String(row.scope_user_id),
  user: (row) => bareKey(row.id),
};

const TABLE_RE = /FROM\s+([a-z_]+)/i;
const tableOf = (query: string): string => TABLE_RE.exec(query)?.[1] ?? "";

// The fake forwarder: a SurrealDB stand-in that enforces the bound owner var.
const fakeForward: AdminForward = (query, vars) => {
  const table = tableOf(query);
  const rows = DATASET[table] ?? [];
  const owner = OWNER[table];
  const userId = vars?.userId;
  const filtered =
    userId === undefined || !owner
      ? rows
      : rows.filter((row) => owner(row) === userId);
  return Promise.resolve([{ result: filtered, status: "OK" }] as SqlResult[]);
};

const contextForSubject = (subjectId: string) => {
  const recordConsequentAudit = vi.fn(() => Promise.resolve());
  const ctx = {
    exportUserData: makeExportSink(fakeForward).exportUserData,
    now: Date.parse("2026-07-02T09:00:00.000Z"),
    recordConsequentAudit,
    session: { id: "sess-a", user: { id: subjectId, role: "member" } },
  };
  return { ctx, recordConsequentAudit };
};

test("a subject's export bundle contains ONLY that subject's rows (zero cross-scope leakage)", async () => {
  const { ctx } = contextForSubject(SUBJECT_A);
  const caller = appRouter.createCaller(ctx as never);
  const bundle = await caller.compliance.exportMyData();

  expect(bundle.subject_user_id).toBe(SUBJECT_A);
  // The P0: not one foreign row anywhere in the bundle.
  expect(bundleForeignRows(bundle)).toEqual([]);
  // Each collection carries exactly A's single row — B's mixed-in rows never enter.
  expect(bundle.profile.map((row) => row.id)).toEqual([SUBJECT_A]);
  expect(bundle.documents.map((row) => row.scope_user_id)).toEqual([SUBJECT_A]);
  expect(bundle.deltas.map((row) => row.scope_user_id)).toEqual([SUBJECT_A]);
  expect(bundle.audit_trail.map((row) => row.actor)).toEqual([SUBJECT_A]);
});

test("an adversarial client-supplied subject id is IGNORED — the scope never widens to another subject", async () => {
  const { ctx } = contextForSubject(SUBJECT_A);
  const caller = appRouter.createCaller(ctx as never);
  // A forged `subjectId` pointing at subject B is stripped by the input schema and
  // never read by the resolver — the bundle stays scoped to the session subject.
  const bundle = await caller.compliance.exportMyData({
    subjectId: SUBJECT_B,
  } as never);

  expect(bundle.subject_user_id).toBe(SUBJECT_A);
  expect(bundleForeignRows(bundle)).toEqual([]);
  expect(bundle.audit_trail.some((row) => row.actor === SUBJECT_B)).toBe(false);
});

test("the export records both a request and a completion audit event for the subject", async () => {
  const { ctx, recordConsequentAudit } = contextForSubject(SUBJECT_A);
  const caller = appRouter.createCaller(ctx as never);
  await caller.compliance.exportMyData();

  expect(recordConsequentAudit).toHaveBeenCalledTimes(2);
  expect(recordConsequentAudit).toHaveBeenNthCalledWith(1, {
    action: "user.data_export_requested",
    actor: SUBJECT_A,
    target: SUBJECT_A,
  });
  expect(recordConsequentAudit).toHaveBeenNthCalledWith(2, {
    action: "user.data_export_completed",
    actor: SUBJECT_A,
    target: SUBJECT_A,
  });
});
