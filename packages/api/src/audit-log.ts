// The admin-only audit read procedure + the system-level audit write gate.
//
// This is the tRPC (first) leg of the two-layer audit perimeter; the SurrealDB
// row-level PERMISSIONS on `audit_log` are the second leg (append-only for every
// role incl. superadmin; admin/superadmin-only SELECT; system/admin-gated CREATE).
// Both legs derive their admin/superadmin decision from the ONE single-sourced
// role->capability matrix in @perry-starter/auth, so they cannot drift.
//
// Read: a below-admin session is denied FORBIDDEN with a generic neutral message
// and NO rows leak; an admin/superadmin reads a keyset-paginated page (no OFFSET).
// Write: there is NO client-callable procedure that appends, updates, redacts, or
// clears audit rows — the append is a system-level write authorized here and gated
// again at the row layer, so an arbitrary authenticated session cannot forge an
// event with an arbitrary action.

import { resolveGlobalRoles, roles } from "@perry-starter/auth/rbac";
import {
  type AuditEntry,
  auditEntrySchema,
} from "@perry-starter/db/shapes/audit-entry";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";

// A generic, enumeration-silent denial message: it never names the audit resource,
// so a non-admin caller learns only "insufficient role", not that a trail exists.
export const AUDIT_READ_FORBIDDEN_MESSAGE = "Insufficient role for this scope";

// The audit-read capability from the single-sourced matrix. member lacks it;
// admin/superadmin hold it — so the decision cannot diverge from the row leg.
const AUDIT_READ_CAPABILITY = { audit: ["read"] } as const;

// The write tiers the DB CREATE grant mirrors (admin/superadmin), plus the trusted
// system flow. A below-admin session resolves to neither.
const WRITE_TIERS = new Set(["admin", "superadmin"]);

const KEYSET_DEFAULT_LIMIT = 50;
const KEYSET_MAX_LIMIT = 200;

// Crockford base32, exactly 26 chars — the ULID charset. A validated ULID is
// charset-restricted, so it is safe to inline as a record-id literal.
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

interface AuthorizingRole {
  readonly authorize: (
    request: Record<string, readonly string[]>,
    connector?: "AND" | "OR"
  ) => { readonly success: boolean };
}
const ROLES = roles as unknown as Record<string, AuthorizingRole | undefined>;

// Allow iff ANY resolved GLOBAL tier holds audit:read (multi-role claims split on
// ','). Keyed on the GLOBAL role claim, never an org-structural role.
const authorizeAuditRead = (roleClaim: string): boolean =>
  resolveGlobalRoles({ user: { role: roleClaim } }).some((tier) => {
    const role = ROLES[tier];
    return role ? role.authorize(AUDIT_READ_CAPABILITY, "AND").success : false;
  });

// --- The system-level write gate (d46: audit writes are not fail-open) ---------

// A write flow is either the trusted server/system context (the privileged
// forwarder, which bypasses row PERMISSIONS) or a concrete session. A session may
// append only if it resolves to admin/superadmin — mirroring the row-layer CREATE
// grant — so an arbitrary authenticated member session can never append.
export type AuditWriter =
  | { readonly kind: "system" }
  | { readonly kind: "session"; readonly role: string };

export const authorizeAuditWrite = (writer: AuditWriter): boolean => {
  if (writer.kind === "system") {
    return true;
  }
  return resolveGlobalRoles({ user: { role: writer.role } }).some((tier) =>
    WRITE_TIERS.has(tier)
  );
};

// The write-input validator: the server supplies the actor/action/target/metadata;
// `id` (the ULID idempotency key) and `timestamp` (server-generated ISO-8601) are
// assigned server-side, so they are omitted. `action` stays confined to the closed
// `<domain>.<verb>` vocabulary by the inherited regex — an arbitrary action string
// is rejected here, before it ever reaches the DB ASSERT.
export const auditWriteInputSchema = auditEntrySchema.omit({
  id: true,
  timestamp: true,
});
export type AuditWriteInput = z.infer<typeof auditWriteInputSchema>;

export interface AuditWriteSql {
  readonly query: string;
  readonly vars: Record<string, string>;
}

// Build the system-level append. The validated ULID record id is inlined (charset-
// restricted, injection-safe); the arbitrary-byte scalar fields travel as bound
// `$vars`, never spliced into the statement body; `metadata` is inlined as a
// JSON literal (JSON.stringify escapes every special char, so an attacker cannot
// break out of the object). It is a CREATE, not an UPSERT: a duplicate id is
// rejected rather than silently overwritten, keeping the trail strictly append-only.
export const buildAuditWriteSql = (
  id: string,
  input: AuditWriteInput
): AuditWriteSql => {
  const entry = auditWriteInputSchema.parse(input);
  if (!ULID_RE.test(id)) {
    throw new Error("audit entry id must be a ULID");
  }
  const vars: Record<string, string> = {
    action: entry.action,
    actor: entry.actor,
    actor_email: entry.actor_email,
    actor_role: entry.actor_role,
    target_type: entry.target_type,
    target_id: entry.target_id,
    ip: entry.ip,
    user_agent: entry.user_agent,
  };
  const query = `CREATE type::record('audit_log', '${id}') SET action = $action, actor = $actor, actor_email = $actor_email, actor_role = $actor_role, target_type = $target_type, target_id = $target_id, metadata = ${JSON.stringify(entry.metadata)}, ip = $ip, user_agent = $user_agent RETURN AFTER;`;
  return { query, vars };
};

// --- The keyset read query (no OFFSET) ----------------------------------------

export const auditListInput = z.object({
  // The keyset cursor is the last-seen ULID record-id key; the page returns the
  // entries strictly older than it (newest-first). Absent = the newest page.
  cursor: z.string().regex(ULID_RE).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(KEYSET_MAX_LIMIT)
    .default(KEYSET_DEFAULT_LIMIT),
});
export type AuditListInput = z.infer<typeof auditListInput>;

// Build the newest-first keyset SELECT. The continuation reads rows whose id is
// strictly less than the cursor, ordered by id DESC — a keyset walk, never an
// OFFSET/START deep page. The cursor is a validated ULID inlined into a record-id
// literal (charset-restricted, injection-safe).
export const buildAuditKeysetSql = (input: AuditListInput): string => {
  // Defense in depth: re-validate the cursor charset before inlining it into the
  // record-id literal, even though the tRPC input schema already constrains it —
  // a caller reaching this builder directly can never inject via the cursor.
  if (input.cursor !== undefined && !ULID_RE.test(input.cursor)) {
    throw new Error("audit keyset cursor must be a ULID");
  }
  const where = input.cursor
    ? ` WHERE id < type::record('audit_log', '${input.cursor}')`
    : "";
  return `SELECT * FROM audit_log${where} ORDER BY id DESC LIMIT ${input.limit};`;
};

// A guard proving the read is an index-backed keyset walk: it orders + limits and
// never deep-pages via OFFSET/START.
const KEYSET_ORDER_RE = /\bORDER\s+BY\s+id\b/i;
const KEYSET_LIMIT_RE = /\bLIMIT\b/i;
const KEYSET_OFFSET_RE = /\b(?:OFFSET|START)\b/i;
export const isKeysetAuditRead = (query: string): boolean =>
  KEYSET_ORDER_RE.test(query) &&
  KEYSET_LIMIT_RE.test(query) &&
  !KEYSET_OFFSET_RE.test(query);

// --- The read-row mapper -------------------------------------------------------

const idFromRecord = (raw: unknown): string => {
  const value =
    typeof raw === "string" ? raw : ((raw as { id?: string } | null)?.id ?? "");
  const key = value.includes(":")
    ? value.slice(value.lastIndexOf(":") + 1)
    : value;
  return key.replace(/[⟨⟩`]/g, "");
};

// Map a raw SurrealDB row into a validated AuditEntry: extract the bare ULID from
// the `audit_log:<ulid>` record id and normalize the datetime to millisecond ISO.
// Parsing through auditEntrySchema means a drifted/oversized row can never surface.
export const mapAuditRow = (raw: Record<string, unknown>): AuditEntry => {
  const timestamp =
    typeof raw.timestamp === "string"
      ? new Date(raw.timestamp).toISOString()
      : "";
  return auditEntrySchema.parse({
    id: idFromRecord(raw.id),
    action: raw.action,
    actor: raw.actor,
    actor_email: raw.actor_email,
    actor_role: raw.actor_role,
    target_type: raw.target_type,
    target_id: raw.target_id,
    metadata: raw.metadata,
    ip: raw.ip,
    user_agent: raw.user_agent,
    timestamp,
  });
};

// --- The admin-only read procedure (the tRPC leg) ------------------------------

interface AuditReadSession {
  readonly user: { readonly id: string; readonly role: string };
}
export interface AuditContext {
  // The bound read leg: the host wires the privileged forwarder that runs the
  // keyset SELECT (which the row-level SELECT permission scopes to admin/superadmin
  // again). Injected so the middleware decision is exercised without a live DB.
  readonly readAuditEntries: (
    input: AuditListInput
  ) => Promise<readonly AuditEntry[]>;
  readonly session: AuditReadSession | null;
}

const auditCodeFor = (error: unknown): string | undefined =>
  error instanceof TRPCError ? error.code : undefined;

const tAudit = initTRPC.context<AuditContext>().create({
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: { ...shape.data, code: auditCodeFor(error) ?? shape.data.code },
  }),
});

// Read is gated to admin/superadmin. A denial NEVER reads any rows (it throws
// before the query leg), so a non-admin caller leaks nothing.
const auditReadProcedure = tAudit.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }
  if (!authorizeAuditRead(ctx.session.user.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: AUDIT_READ_FORBIDDEN_MESSAGE,
    });
  }
  return next();
});

// Read-only by construction: the router exposes ONLY `list`. No procedure updates,
// redacts, or clears audit rows — immutability is not undermined by the API surface.
export const auditRouter = tAudit.router({
  list: auditReadProcedure
    .input(auditListInput)
    .query(async ({ ctx, input }) => ({
      entries: await ctx.readAuditEntries(input),
    })),
});

export const createAuditReadCaller = (ctx: AuditContext) =>
  auditRouter.createCaller(ctx);

// Project a thrown read error into its native tRPC code + message (for tests /
// callers switching on the denial).
export const auditReadErrorShape = (
  error: unknown
): { readonly nativeCode?: string; readonly message?: string } => {
  if (error instanceof TRPCError) {
    return { nativeCode: error.code, message: error.message };
  }
  return {};
};

// Introspect the router's exposed procedures so a conformance test can assert the
// audit surface is read-only (every procedure is a query; none is a mutation, and
// none is named for a destructive op).
export const auditRouterProcedures = (): ReadonlyArray<{
  readonly name: string;
  readonly type: string;
}> => {
  const procedures = (
    auditRouter as unknown as {
      _def: { procedures: Record<string, { _def: { type: string } }> };
    }
  )._def.procedures;
  return Object.entries(procedures).map(([name, procedure]) => ({
    name,
    type: procedure._def.type,
  }));
};
