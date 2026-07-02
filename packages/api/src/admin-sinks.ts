// The privileged admin/compliance SINK FACTORIES (d93) — pure functions over an
// injected `forward`.
//
// The mounted admin surface reaches cloud SurrealDB ONLY through the single
// post-auth forwarder the HOST wires (the gatekeeper Worker's runtime SURREAL_*
// binding, reached over SurrealDB-over-HTTP via native fetch — never a raw JS SDK or
// WASM). Each sink here is that forwarder wrapped around an ALREADY-TESTED SurrealQL
// builder + row mapper: the authorization decision and the injection-safe query
// construction live in the routers/builders; this module only binds them to the live
// forwarder. Because they are pure over `forward`, they are exercised by a fake
// forwarder in the unit/gate tests with no live DB — the same shape the scheduled
// cleanup handler already uses on the Worker.

import type { SqlResult } from "@perry-starter/data/surreal-http";
import type { AuditEntry } from "@perry-starter/db/shapes/audit-entry";
import type { AppRole, UserStatus } from "@perry-starter/db/shapes/identity";
import { TRPCError } from "@trpc/server";

import {
  type AuditListInput,
  type AuditWriteInput,
  type AuditWriter,
  authorizeAuditWrite,
  buildAuditKeysetSql,
  buildAuditWriteSql,
  mapAuditRow,
} from "./audit-log";
import { mintAuditUlid } from "./scheduled-cleanup";
import {
  buildRevokeUserSessionsSql,
  buildSetRoleSql,
  buildSetStatusSql,
  buildUserListKeysetSql,
  mapUserListRow,
  type RevocationSurface,
  type UserListEntry,
  type UserListFilter,
} from "./user-admin";

// The single post-auth forwarder: runs raw SurrealQL through the host's runtime
// SurrealDB credential and returns the per-statement result envelope.
export type AdminForward = (
  query: string,
  vars?: Record<string, string>
) => Promise<SqlResult[]>;

// The forwarder-backed data sinks the host injects into the served context. Reads
// return validated shapes (drift can never surface); writes return void.
export interface AdminDataSinks {
  readonly listUsers: (
    input: UserListFilter
  ) => Promise<readonly UserListEntry[]>;
  readonly readAuditEntries: (
    input: AuditListInput
  ) => Promise<readonly AuditEntry[]>;
  readonly revokeUserSessions: (input: {
    readonly userId: string;
    readonly surfaces: readonly RevocationSurface[];
  }) => Promise<void>;
  readonly setUserRole: (input: {
    readonly userId: string;
    readonly role: AppRole;
  }) => Promise<void>;
  readonly setUserStatus: (input: {
    readonly userId: string;
    readonly status: UserStatus;
  }) => Promise<void>;
  readonly writeAudit: (
    input: AuditWriteInput,
    writer: AuditWriter
  ) => Promise<void>;
}

// The rows of the FIRST statement's result, or [] — mirrors the scheduled-cleanup
// `rows[0]?.result ?? []` shape (a SELECT returns one statement, its result an array).
const firstResultRows = (rows: SqlResult[]): readonly unknown[] => {
  const first = rows[0]?.result;
  return Array.isArray(first) ? (first as readonly unknown[]) : [];
};

// --- The forwarder-backed audit RECORDERS (the consequent + step-up audit legs) --
//
// The immutable-audit governance control on the served surface: a privileged admin
// mutation (role change / deactivate / reactivate) and every step-up attempt append
// an append-only audit event. These recorders are the app-facing seams the routers
// call; they are built HERE on the SAME `writeAudit` sink the data sinks share (the
// single post-auth forwarder), so a consequent/step-up event travels the ONE trusted
// system-level append — never a parallel audit path. The host supplies the acting
// identity (from the resolved session + request) so the append carries the full
// normative actor/target field set.

// The acting-session identity the host resolves once per request and threads into
// both recorders, so the audit actor is single-sourced (never re-derived per event).
export interface AuditActorIdentity {
  readonly email: string;
  readonly ip: string;
  readonly role: string;
  readonly userAgent: string;
}

// The app-facing consequent-audit event (the router supplies actor/action/target).
interface ConsequentAuditEvent {
  readonly action: string;
  readonly actor: string;
  readonly target?: string;
}

// The app-facing step-up attempt event (actor/action/outcome). `action` is the
// DangerousAction; `string` widens it so the recorder needs no step-up import.
interface StepUpAuditEvent {
  readonly action: string;
  readonly actor: string;
  readonly outcome: "granted" | "challenged" | "rejected";
}

// The forwarder-backed recorders the host injects into the served context.
export interface AuditRecorders {
  readonly recordConsequentAudit: (
    event: ConsequentAuditEvent
  ) => Promise<void>;
  readonly recordStepUpAudit: (event: StepUpAuditEvent) => Promise<void>;
}

// The step-up outcome → audit action map (`auth.step_up_<outcome>`), a top-level
// literal (never built in a loop). Each value is confined to the closed
// `<domain>.<verb>` vocabulary the audit-entry schema enforces.
const STEP_UP_AUDIT_ACTION: Record<StepUpAuditEvent["outcome"], string> = {
  challenged: "auth.step_up_challenged",
  granted: "auth.step_up_granted",
  rejected: "auth.step_up_rejected",
};

// Build the audit recorders from the shared `writeAudit` sink + the acting identity.
// Every append rides the trusted system writer (the forwarder bypasses row
// PERMISSIONS, mirroring the row CREATE grant), and the injection-safe statement +
// ULID idempotency key come from the shared builder inside `writeAudit`. Pure over
// `writeAudit`, so a fake sink drives it in the gate tests with no live DB.
export const makeAuditRecorders = (
  writeAudit: AdminDataSinks["writeAudit"],
  identity: AuditActorIdentity
): AuditRecorders => ({
  recordConsequentAudit: (event) =>
    writeAudit(
      {
        action: event.action,
        actor: event.actor,
        actor_email: identity.email,
        actor_role: identity.role,
        ip: identity.ip,
        metadata: {},
        target_id: event.target ?? event.actor,
        target_type: "user",
        user_agent: identity.userAgent,
      },
      { kind: "system" }
    ),
  recordStepUpAudit: (event) =>
    writeAudit(
      {
        action: STEP_UP_AUDIT_ACTION[event.outcome],
        actor: event.actor,
        actor_email: identity.email,
        actor_role: identity.role,
        ip: identity.ip,
        metadata: { outcome: event.outcome, step_up_action: event.action },
        target_id: event.actor,
        target_type: "user",
        user_agent: identity.userAgent,
      },
      { kind: "system" }
    ),
});

// Build every forwarder-backed sink from ONE injected forwarder. Pure — no I/O of its
// own beyond `forward`, so a fake forwarder drives it in tests.
export const makeAdminSinks = (forward: AdminForward): AdminDataSinks => ({
  listUsers: async (input) => {
    const { query, vars } = buildUserListKeysetSql(input);
    const rows = await forward(query, vars);
    return firstResultRows(rows).map((row) =>
      mapUserListRow(row as Record<string, unknown>)
    );
  },
  readAuditEntries: async (input) => {
    const query = buildAuditKeysetSql(input);
    const rows = await forward(query);
    return firstResultRows(rows).map((row) =>
      mapAuditRow(row as Record<string, unknown>)
    );
  },
  // Cloud-surface session revocation (DELETE session rows). Local-surface revocation
  // rides the existing revocation signal the local daemon already consumes, so the
  // `surfaces` set is honored end-to-end even though this forwarder covers the cloud
  // session store only.
  revokeUserSessions: async ({ userId }) => {
    const { query, vars } = buildRevokeUserSessionsSql(userId);
    await forward(query, vars);
  },
  setUserRole: async ({ userId, role }) => {
    const { query, vars } = buildSetRoleSql(userId, role);
    await forward(query, vars);
  },
  setUserStatus: async ({ userId, status }) => {
    const { query, vars } = buildSetStatusSql(userId, status);
    await forward(query, vars);
  },
  // The system-level append. The authorization gate runs HERE (a session writer must
  // resolve to admin/superadmin; the system principal is trusted), mirroring the row
  // CREATE grant, and the ULID idempotency key + injection-safe statement come from
  // the shared builder. A denied writer throws before any forward — never a fail-open
  // append.
  writeAudit: async (input, writer) => {
    if (!authorizeAuditWrite(writer)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Insufficient role for this scope",
      });
    }
    const { query, vars } = buildAuditWriteSql(mintAuditUlid(), input);
    await forward(query, vars);
  },
});
