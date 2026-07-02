// The self-scoped GDPR data-export procedure + its forwarder-backed sink.
//
// better-auth ships NO data-export endpoint, so this is a fully custom self-service
// export. The scope is the SERVER-DERIVED subject `ctx.session.user.id` — the sole
// perimeter — never a client-supplied id: the input schema strips any extra field
// and the resolver reads ONLY the session, so a client cannot widen the scope.
//
// Every owned collection is read through the single post-auth forwarder the host
// wires (the gatekeeper Worker's runtime SurrealDB binding), each read built with a
// `WHERE <owner> = $userId` predicate whose subject travels as a BOUND $var — never
// string-interpolated. Because the owner predicate (not the caller) enforces the
// scope, no path lets another subject's rows into the bundle. On a tier with no
// forwarder the sink is absent and the export FAILS CLOSED (`requireSink`).
//
// The export REQUEST and COMPLETION are both audited outermost through the same
// forwarder-backed `writeAudit` recorder, so the compliance operation is
// evidence-bearing on the immutable audit log.

import type { SqlResult } from "@perry-starter/data/surreal-http";
import {
  type DataExportBundle,
  type DataExportCollections,
  dataExportBundleSchema,
  type ExportedProfile,
  exportedDocumentSchema,
  exportedProfileSchema,
} from "@perry-starter/db/shapes/data-export";
import { deltaEnvelopeSchema } from "@perry-starter/db/shapes/delta-envelope";
import { z } from "zod";

import type { AdminForward } from "./admin-sinks";
import { mapAuditRow } from "./audit-log";
import { requireSink } from "./fail-closed";
import { protectedProcedure, router } from "./index";

// The owned SurrealDB tables the export reads. Named constants (never built in a
// loop) so the table names are single-sourced with the rest of the stack.
const USER_TABLE = "user";
const DOCUMENT_PROJECTION_TABLE = "document_projection";
const DELTA_TABLE = "document_delta";
const AUDIT_TABLE = "audit_log";

// The audit vocabulary for the export lifecycle. Both fit the closed
// `<domain>.<verb>` audit-action set (domain `user`), so the append-only audit
// schema accepts them.
export const DATA_EXPORT_REQUESTED_ACTION = "user.data_export_requested";
export const DATA_EXPORT_COMPLETED_ACTION = "user.data_export_completed";

export interface ExportReadSql {
  readonly query: string;
  readonly vars: Record<string, string>;
}

// --- The self-scoped read builders (owner predicate bound as $userId) ---------
//
// Each builder binds the SERVER-DERIVED subject as `$userId`; the value never
// touches the query body. A read with no `$userId` binding (or one that trusts a
// client id) is a scope leak — the cross-scope isolation guard proves the bound
// predicate is what enforces the perimeter.

// The subject's own identity row. The record id is matched via a var-bound
// type::record target, so the subject key is never spliced into the statement.
export const buildProfileExportSql = (userId: string): ExportReadSql => ({
  query: `SELECT id, email, locale, given_name, family_name, role, status FROM ${USER_TABLE} WHERE id = type::record('${USER_TABLE}', $userId);`,
  vars: { userId },
});

// The subject's own documents (the materialized projection), owner-scoped.
export const buildDocumentsExportSql = (userId: string): ExportReadSql => ({
  query: `SELECT doc_id, scope_user_id, title, body_preview FROM ${DOCUMENT_PROJECTION_TABLE} WHERE scope_user_id = $userId;`,
  vars: { userId },
});

// The subject's own delta-log envelopes, owner-scoped.
export const buildDeltasExportSql = (userId: string): ExportReadSql => ({
  query: `SELECT id, scope_user_id, doc_id, doc_schema_version, cursor, payload FROM ${DELTA_TABLE} WHERE scope_user_id = $userId;`,
  vars: { userId },
});

// The subject's OWN audit entries (actor = the subject) — never another subject's.
export const buildAuditExportSql = (userId: string): ExportReadSql => ({
  query: `SELECT * FROM ${AUDIT_TABLE} WHERE actor = $userId ORDER BY id DESC;`,
  vars: { userId },
});

// The rows of the FIRST statement's result, or [] — mirrors the admin-sink shape.
const firstResultRows = (rows: SqlResult[]): readonly unknown[] => {
  const first = rows[0]?.result;
  return Array.isArray(first) ? (first as readonly unknown[]) : [];
};

// Strip a SurrealDB record link (`user:<key>`) down to its bare key, so the
// exported profile id equals the plain `subject_user_id`.
const RECORD_DECORATION_RE = /[⟨⟩`]/g;
const bareRecordKey = (raw: unknown): string => {
  const value =
    typeof raw === "string" ? raw : ((raw as { id?: string } | null)?.id ?? "");
  const key = value.includes(":")
    ? value.slice(value.lastIndexOf(":") + 1)
    : value;
  return key.replace(RECORD_DECORATION_RE, "");
};

// Map a raw `user` row into the validated exported profile (bare id key). Parsing
// through the schema means a drifted/oversized row can never surface.
export const mapExportProfileRow = (
  raw: Record<string, unknown>
): ExportedProfile =>
  exportedProfileSchema.parse({
    id: bareRecordKey(raw.id),
    email: raw.email,
    locale: raw.locale,
    given_name: raw.given_name,
    family_name: raw.family_name,
    role: raw.role,
    status: raw.status,
  });

// The forwarder-backed export sink the host injects. Pure over `forward`, so a fake
// forwarder drives it in the gate tests with no live DB.
export interface AdminExportSink {
  readonly exportUserData: (userId: string) => Promise<DataExportCollections>;
}

// Build the export sink from ONE injected forwarder. Every read is owner-scoped by
// its builder's bound `$userId`; the rows are parsed through the canonical shapes,
// so nothing un-validated (or, given the predicate, off-subject) enters the bundle.
export const makeExportSink = (forward: AdminForward): AdminExportSink => ({
  exportUserData: async (userId) => {
    const profileSql = buildProfileExportSql(userId);
    const documentsSql = buildDocumentsExportSql(userId);
    const deltasSql = buildDeltasExportSql(userId);
    const auditSql = buildAuditExportSql(userId);

    const profile = firstResultRows(
      await forward(profileSql.query, profileSql.vars)
    ).map((row) => mapExportProfileRow(row as Record<string, unknown>));
    const documents = firstResultRows(
      await forward(documentsSql.query, documentsSql.vars)
    ).map((row) => exportedDocumentSchema.parse(row));
    const deltas = firstResultRows(
      await forward(deltasSql.query, deltasSql.vars)
    ).map((row) => deltaEnvelopeSchema.parse(row));
    const audit_trail = firstResultRows(
      await forward(auditSql.query, auditSql.vars)
    ).map((row) => mapAuditRow(row as Record<string, unknown>));

    return { audit_trail, deltas, documents, profile };
  },
});

// --- The cross-scope isolation guard (the P0) ---------------------------------
//
// Return every bundle row whose OWNER key differs from the bundle's subject — the
// profile id, the document/delta `scope_user_id`, and the audit `actor` must all
// equal `subject_user_id`. A correctly self-scoped export returns []; a bundle
// carrying a foreign subject's row (a dropped owner predicate, or a client-supplied
// id honored) returns a non-empty list, so the isolation assertion reddens on it.
export const bundleForeignRows = (
  bundle: DataExportBundle
): readonly string[] => {
  const subject = bundle.subject_user_id;
  const foreign: string[] = [];
  for (const row of bundle.profile) {
    if (row.id !== subject) {
      foreign.push(`profile:${row.id}`);
    }
  }
  for (const row of bundle.documents) {
    if (row.scope_user_id !== subject) {
      foreign.push(`document:${row.doc_id}`);
    }
  }
  for (const row of bundle.deltas) {
    if (row.scope_user_id !== subject) {
      foreign.push(`delta:${row.id}`);
    }
  }
  for (const row of bundle.audit_trail) {
    if (row.actor !== subject) {
      foreign.push(`audit:${row.id}`);
    }
  }
  return foreign;
};

// --- The mounted export procedure --------------------------------------------

// The export request input carries NO subject id. The default object mode STRIPS
// any extra field a client sends (e.g. a forged `subjectId`), and the resolver
// reads ONLY the session — so a client-supplied subject id can never widen the
// scope. `.default({})` lets the one-click call carry no body at all.
export const dataExportRequestSchema = z.object({}).default({});

// The export procedure's injected deps: the export sink + the consequent-audit
// recorder (both forwarder-backed on the served surface, absent — fail-closed — on
// the relay). Single-sourced so the Context can `Pick` them without drift.
export interface ComplianceContext {
  readonly exportUserData?: AdminExportSink["exportUserData"];
  readonly now?: number;
  readonly recordConsequentAudit?: (event: {
    readonly action: string;
    readonly actor: string;
    readonly target?: string;
  }) => Promise<void> | void;
  readonly session: {
    readonly user: { readonly id: string };
  } | null;
}

export const complianceRouter = router({
  // One-click self-service export. Any authenticated member may export their OWN
  // data; the scope is the server-derived subject, so no role gate is needed and
  // none is applied (this is a self-service right, not an admin oversight action).
  exportMyData: protectedProcedure
    .input(dataExportRequestSchema)
    .query(async ({ ctx }): Promise<DataExportBundle> => {
      // The subject is the SERVER-derived session user id — the sole perimeter.
      // The stripped input is never read, so a client-supplied subject id cannot
      // reach this scope.
      const userId = ctx.session.user.id;

      // Resolve the fail-closed seams up front: on a tier with no forwarder BOTH the
      // audit recorder and the export sink are absent, so the export can never run
      // (or be recorded as requested) without its immutable-audit leg wired.
      const recordConsequentAudit = requireSink(
        ctx.recordConsequentAudit,
        "recordConsequentAudit"
      );
      const exportUserData = requireSink(ctx.exportUserData, "exportUserData");

      // Audit the REQUEST (actor = target = the subject).
      await recordConsequentAudit({
        action: DATA_EXPORT_REQUESTED_ACTION,
        actor: userId,
        target: userId,
      });

      const collections = await exportUserData(userId);
      const bundle = dataExportBundleSchema.parse({
        exported_at: new Date(ctx.now ?? Date.now()).toISOString(),
        subject_user_id: userId,
        ...collections,
      });

      // Audit the COMPLETION.
      await recordConsequentAudit({
        action: DATA_EXPORT_COMPLETED_ACTION,
        actor: userId,
        target: userId,
      });

      return bundle;
    }),
});

// Re-export the canonical bundle type for the served-surface / test callers.
export type { DataExportBundle } from "@perry-starter/db/shapes/data-export";
