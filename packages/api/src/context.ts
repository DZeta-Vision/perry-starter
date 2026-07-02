// The unified served context + its builders.
//
// ONE tRPC surface serves the whole admin/compliance backend (the audit / user-admin
// / step-up / invitation sub-routers all build on the single `t`). This context is
// what that surface reads: the server-resolved session PLUS the injected privileged
// sinks. The sinks are OPTIONAL — the HOST that actually holds the runtime SurrealDB
// binding (the gatekeeper Worker) injects the forwarder-backed sinks; any tier
// without that binding (the web relay) leaves them absent, so every SurrealDB-backed
// procedure FAILS CLOSED (`requireSink`) rather than returning unprivileged data.
//
// Shape C′ topology: the gatekeeper Worker is the SOLE holder of the runtime
// SurrealDB binding, so the privileged surface runs THERE (built via
// `buildAdminContext({ surreal })`). The web relay serves the same router with
// `createContext` (session only) and fails closed on every privileged procedure —
// the web UI routes admin calls to the Worker surface.

import { auth } from "@perry-starter/auth";
import { recordStepUpFailure } from "@perry-starter/auth/lockout-seam";
import {
  createStepUpGrantStore,
  type StepUpGrantStore,
} from "@perry-starter/auth/step-up-store";
import { type SurrealAuth, sql } from "@perry-starter/data/surreal-http";

import {
  type AdminDataSinks,
  type AdminForward,
  type AuditActorIdentity,
  makeAdminSinks,
  makeAuditRecorders,
} from "./admin-sinks";
import type { AuditContext } from "./audit-log";
import { type AdminExportSink, makeExportSink } from "./data-export";
import { type ErasureSink, makeErasureSink } from "./erasure";
import type { InvitationContext } from "./invitations";
import type { UserAdminContext } from "./user-admin";

// The server-resolved session the served surface binds to. `id` is the SESSION
// identity a step-up grant binds to; `user.id` is the account subject the audit
// actor + lockout seam key on; `user.role` is the GLOBAL role claim the RBAC legs
// resolve. This is the projection every admin router reads (never the raw
// better-auth `{ user, session }` envelope).
export interface AdminSession {
  readonly id: string;
  readonly user: { readonly id: string; readonly role: string };
}

// The unified served context. `session` is required (null when unauthenticated);
// every privileged sink is optional so its absence fails the procedure closed. The
// per-router injected deps are single-sourced off the router context interfaces via
// `Pick`, so a sink's signature can never drift between the context and its router.
export type Context = {
  readonly now?: number;
  readonly session: AdminSession | null;
  readonly stepUpToken?: string;
  readonly writeAudit?: AdminDataSinks["writeAudit"];
  // The forwarder-backed self-scoped data-export sink. Absent on the relay tier,
  // so the export procedure fails closed (`requireSink`) there.
  readonly exportUserData?: AdminExportSink["exportUserData"];
  // The forwarder-backed self-service erasure sinks (soft-delete + crypto-shred
  // registration). Absent on the relay tier, so the erasure request fails closed.
  readonly registerShredSubject?: ErasureSink["registerShredSubject"];
  readonly softDeleteForErasure?: ErasureSink["softDeleteForErasure"];
} & Partial<Pick<AuditContext, "readAuditEntries">> &
  Partial<
    Pick<
      UserAdminContext,
      | "listUsers"
      | "recordConsequentAudit"
      | "recordLockoutFailure"
      | "recordStepUpAudit"
      | "revokeSession"
      | "revokeUserSessions"
      | "setUserRole"
      | "setUserStatus"
      | "stepUpStore"
    >
  > &
  Partial<
    Pick<
      InvitationContext,
      | "loadInvitationByTokenHash"
      | "markInvitationAccepted"
      | "persistInvitation"
      | "provisionInvitedAccount"
      | "revokePriorInvitations"
      | "sendInvitationEmail"
    >
  >;

// The SurrealDB-over-HTTP forwarder config the host supplies (the gatekeeper's
// runtime SURREAL_* binding). Absent on the relay tier.
export interface AdminSurrealConfig {
  readonly db: string;
  readonly ns: string;
  readonly pass: string;
  readonly url: string;
  readonly user: string;
}

// The request header carrying the presented step-up grant token. Middleware runs
// BEFORE `.input()` parsing, so a step-up grant can never ride the validated input —
// it is threaded off this header instead.
export const STEP_UP_TOKEN_HEADER = "x-step-up-token";

// ONE in-process step-up grant store per server isolate: a grant issued on one
// request is consumable on a later request in the SAME isolate. DEFERRED: a
// cross-isolate durable store (the DO/Surreal-backed variant the store interface
// already anticipates) — until then a grant does not survive an isolate recycle.
const stepUpStore: StepUpGrantStore = createStepUpGrantStore();

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

// The header value or a non-empty sentinel — the audit-entry schema requires a
// non-empty ip/user_agent, so an absent header records "unknown" rather than
// throwing on the append.
const AUDIT_UNKNOWN = "unknown";
const headerOr = (req: Request, ...names: readonly string[]): string => {
  for (const name of names) {
    const value = req.headers.get(name);
    if (value) {
      return value;
    }
  }
  return AUDIT_UNKNOWN;
};

// Resolve the acting-session identity the forwarder-backed audit recorders stamp on
// every append: the actor email/role come off the resolved session projection (the
// customSession surfaces email at the top level and inside `user`), the ip/user-agent
// off the request. Fixed once per request so the audit actor is single-sourced.
const auditIdentityFrom = (
  raw: unknown,
  session: AdminSession | null,
  req: Request
): AuditActorIdentity => {
  const value =
    raw && typeof raw === "object"
      ? (raw as { email?: unknown; user?: { email?: unknown } })
      : {};
  return {
    email: asString(value.email) || asString(value.user?.email),
    ip: headerOr(req, "cf-connecting-ip", "x-forwarded-for"),
    role: session?.user.role || "member",
    userAgent: headerOr(req, "user-agent"),
  };
};

// Project the raw better-auth get-session envelope into the admin session. The
// customSession projection surfaces the GLOBAL role at the top level and inside
// `user`; the session record id lives on `.session.id`. A missing user id resolves
// to no session (fail closed on identity).
const projectAdminSession = (raw: unknown): AdminSession | null => {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as {
    id?: unknown;
    role?: unknown;
    session?: { id?: unknown };
    user?: { id?: unknown; role?: unknown };
  };
  const userId = asString(value.user?.id) || asString(value.id);
  if (userId === "") {
    return null;
  }
  const sessionId = asString(value.session?.id) || userId;
  const role = asString(value.role) || asString(value.user?.role);
  return { id: sessionId, user: { id: userId, role } };
};

// Build the served context. When `surreal` is present (the gatekeeper Worker), the
// single post-auth forwarder is constructed and every forwarder-backed sink injected;
// when absent (the relay), the privileged sinks stay undefined so each SurrealDB-
// backed procedure fails closed. The session + step-up threading + shared lockout
// recorder are wired on BOTH tiers.
export const buildAdminContext = async ({
  req,
  surreal,
}: {
  req: Request;
  surreal?: AdminSurrealConfig;
}): Promise<Context> => {
  const rawSession = await auth.api.getSession({ headers: req.headers });
  const session = projectAdminSession(rawSession);
  const base: Context = {
    now: Date.now(),
    // A failed step-up routes through the SAME shared per-subject counter as a failed
    // login (the seam the Worker binds to the DO recorder at boot).
    recordLockoutFailure: (subject: string) => recordStepUpFailure(subject),
    session,
    stepUpStore,
    stepUpToken: req.headers.get(STEP_UP_TOKEN_HEADER) ?? undefined,
  };
  if (!surreal) {
    return base;
  }
  const credential: SurrealAuth = {
    kind: "basic",
    pass: surreal.pass,
    user: surreal.user,
  };
  const forward: AdminForward = (query, vars) =>
    sql(surreal.url, surreal.ns, surreal.db, credential, query, vars);
  const sinks = makeAdminSinks(forward);
  // The self-scoped data-export sink rides the SAME single post-auth forwarder, so
  // every export read is owner-scoped through the one trusted binding.
  const exportSink = makeExportSink(forward);
  // The self-service erasure sinks (soft-delete tombstone UPDATE + crypto-shred
  // registration) ride the SAME forwarder, so both writes go through the one trusted
  // binding; absent on the relay tier (no forwarder), so erasure fails closed there.
  const erasureSink = makeErasureSink(forward);
  // Wire the consequent + step-up audit recorders on the SAME forwarder-backed
  // `writeAudit` sink as the data sinks, so a privileged mutation's immutable-audit
  // event travels the ONE trusted system-level append. Absent on the relay tier (no
  // forwarder), so the audit-sink `requireSink` guard fails the mutation closed there
  // — symmetric with the data sinks, never an audit fail-open.
  const recorders = makeAuditRecorders(
    sinks.writeAudit,
    auditIdentityFrom(rawSession, session, req)
  );
  return { ...base, ...sinks, ...recorders, ...exportSink, ...erasureSink };
};

// The web relay's context factory (the shape tRPC's fetch adapter calls): session +
// step-up threading only, NO SurrealDB binding — so the privileged admin/compliance
// procedures fail closed here. The live admin surface is served on the gatekeeper
// Worker via `buildAdminContext({ surreal })`.
export function createContext({ req }: { req: Request }): Promise<Context> {
  return buildAdminContext({ req });
}
