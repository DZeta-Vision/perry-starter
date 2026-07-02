// Mutation twin for data-export-isolation.gate.test.ts.
//
// It drives a LEAKY export sink — one that DROPS the owner predicate (reads each
// collection with NO `WHERE <owner> = $userId`, binding no `$userId`) — against the
// SAME fake SurrealDB the gate uses. Because the scope is enforced by the BOUND
// predicate (not the caller), the leaky reads full-scan and B's rows leak into the
// bundle, so `bundleForeignRows` goes NON-EMPTY and the gate's zero-foreign-rows
// assertion reddens on it. It also confirms the REAL sink over the same fake DB
// keeps zero foreign rows — proving the two diverge exactly at the owner predicate.

import type { SqlResult } from "@perry-starter/data/surreal-http";
import {
  type DataExportBundle,
  dataExportBundleSchema,
  exportedDocumentSchema,
} from "@perry-starter/db/shapes/data-export";
import { deltaEnvelopeSchema } from "@perry-starter/db/shapes/delta-envelope";
import { expect, test } from "vitest";

import type { AdminForward } from "../admin-sinks";
import { mapAuditRow } from "../audit-log";
import {
  bundleForeignRows,
  makeExportSink,
  mapExportProfileRow,
} from "../data-export";

type Row = Record<string, unknown>;

const SUBJECT_A = "user-a";
const SUBJECT_B = "user-b";
const DOC_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DOC_B = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const DELTA_A = "01J0XQT8Z9N3H6K2M5P7R9T1V3";
const DELTA_B = "01J0XQT8Z9N3H6K2M5P7R9T1V4";
const B64 = "aGVsbG8=";

const DATASET: Record<string, Row[]> = {
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
    { body_preview: "a", doc_id: DOC_A, scope_user_id: SUBJECT_A, title: "A" },
    { body_preview: "b", doc_id: DOC_B, scope_user_id: SUBJECT_B, title: "B" },
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

const OWNER: Record<string, (row: Row) => string> = {
  document_delta: (row) => String(row.scope_user_id),
  document_projection: (row) => String(row.scope_user_id),
  user: (row) => bareKey(row.id),
};

const TABLE_RE = /FROM\s+([a-z_]+)/i;
const tableOf = (query: string): string => TABLE_RE.exec(query)?.[1] ?? "";

// The SAME SurrealDB stand-in as the gate: it filters by the bound `$userId` when
// present, and full-scans when the predicate/var is absent (the leak surface).
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

const firstRows = (rows: SqlResult[]): Row[] => {
  const first = rows[0]?.result;
  return Array.isArray(first) ? (first as Row[]) : [];
};

// The FAIL-OPEN anti-pattern the gate forbids: an export sink that trusts the DB to
// scope and drops the owner predicate — NO `WHERE`, NO `$userId` bound.
const leakyExport = async (
  forward: AdminForward,
  subjectUserId: string
): Promise<DataExportBundle> => {
  const profile = firstRows(await forward("SELECT * FROM user")).map((row) =>
    mapExportProfileRow(row)
  );
  const documents = firstRows(
    await forward(
      "SELECT doc_id, scope_user_id, title, body_preview FROM document_projection"
    )
  ).map((row) => exportedDocumentSchema.parse(row));
  const deltas = firstRows(
    await forward(
      "SELECT id, scope_user_id, doc_id, doc_schema_version, cursor, payload FROM document_delta"
    )
  ).map((row) => deltaEnvelopeSchema.parse(row));
  return dataExportBundleSchema.parse({
    audit_trail: firstRows(await forward("SELECT * FROM audit_log")).map(
      (row) => mapAuditRow(row)
    ),
    deltas,
    documents,
    exported_at: "2026-07-02T09:00:00.000Z",
    profile,
    subject_user_id: subjectUserId,
  });
};

test("an export sink that DROPS the owner predicate leaks another subject's rows (the isolation assertion reddens)", async () => {
  const leaked = await leakyExport(fakeForward, SUBJECT_A);
  // The gate's assertion is `bundleForeignRows(bundle)` toEqual([]); on the leaky
  // bundle it is NON-empty, so that assertion reddens — the guard is load-bearing.
  expect(bundleForeignRows(leaked)).not.toEqual([]);
  expect(bundleForeignRows(leaked)).toContain(`profile:${SUBJECT_B}`);
});

test("the REAL owner-scoped sink over the SAME fake DB keeps zero foreign rows (the two diverge at the predicate)", async () => {
  const collections =
    await makeExportSink(fakeForward).exportUserData(SUBJECT_A);
  const scoped = dataExportBundleSchema.parse({
    ...collections,
    exported_at: "2026-07-02T09:00:00.000Z",
    subject_user_id: SUBJECT_A,
  });
  expect(bundleForeignRows(scoped)).toEqual([]);
});
