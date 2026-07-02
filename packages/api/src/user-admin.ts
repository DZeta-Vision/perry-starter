// The admin user-management surface: an index-backed keyset user list, the
// superadmin-only role-assignment authority, and a reversible (soft) deactivate.
//
// Two-layer authorization, one matrix: the tRPC procedures here are the in-process
// leg; the SurrealDB row-level PERMISSIONS (generated from the SAME
// role->capability matrix — see `roleAssignmentEscalationPredicate` in
// @perry-starter/auth/rbac) are the second leg. Role assignment is superadmin-only
// AND the numeric hierarchy forbids escalation, so the API can never mint a second
// superadmin, self-target the actor's own row, or assign at/above the actor's tier.
//
// Read-path law: the list is a server keyset walk — `ORDER BY … LIMIT`
// with the cursor as a WHERE bound — NEVER an OFFSET/START deep-page, and it is
// index-backed (an IndexScan over a named index, never a TableScan). The row
// projection omits the `pass` hash, so the list read never leaks a credential.
//
// Dangerous-mutation law: a role change and a deactivate each proceed only
// behind a fresh, single-use, (session, action)-bound step-up grant, and each
// writes an append-only audit event. A role change AND a deactivate revoke the
// TARGET's sessions across BOTH surfaces (cloud + local); the actor's own session
// is never touched. Deactivate is a SOFT status flip (never a hard DELETE), so it
// is fully reversible by reactivate.

import {
  canAssignRole,
  holdsAdminSurface,
  resolveGlobalRoles,
  roleAssignmentTiers,
} from "@perry-starter/auth/rbac";
import type { DangerousAction } from "@perry-starter/auth/step-up";
import type { StepUpGrantStore } from "@perry-starter/auth/step-up-store";
import {
  type AppRole,
  appRoleSchema,
  type UserStatus,
  userStatusSchema,
} from "@perry-starter/db/shapes/identity";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { requireSink } from "./fail-closed";
import { t } from "./index";

// --- The revocation surface set (both legs) ----------------------------------

// A role change and a deactivate revoke the target across BOTH surfaces. The set
// is a constant so a resolver can never narrow the scope to one surface.
export const REVOCATION_SURFACES = ["cloud", "local"] as const;
export type RevocationSurface = (typeof REVOCATION_SURFACES)[number];

// --- The keyset user-list read (no OFFSET) -----------------------------------

const KEYSET_DEFAULT_LIMIT = 50;
const KEYSET_MAX_LIMIT = 200;

// The list row projection — deliberately OMITS the `pass` credential hash, so a
// list read can never leak a hash. Validates the app-role and status against the
// single-sourced identity shapes, so a drifted row can never surface.
export const userListEntrySchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  name: z.string().optional(),
  role: appRoleSchema,
  status: userStatusSchema,
  created_at: z.string().min(1),
  last_active: z.string().optional(),
  invited_by: z.string().optional(),
});
export type UserListEntry = z.infer<typeof userListEntrySchema>;

// The keyset cursor is the `created_at` of the last row on the prior page; the
// next page reads rows strictly OLDER than it (newest-first). The filters
// (role/status/inviter/search) are all WHERE terms. `limit` is bounded.
export const userListFilterSchema = z.object({
  role: appRoleSchema.optional(),
  status: userStatusSchema.optional(),
  invitedBy: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(KEYSET_MAX_LIMIT)
    .default(KEYSET_DEFAULT_LIMIT),
});
export type UserListFilter = z.infer<typeof userListFilterSchema>;

export interface UserListKeysetSql {
  readonly query: string;
  readonly vars: Record<string, string>;
}

// The list column projection (no `pass`).
const LIST_PROJECTION =
  "id, email, name, role, status, created_at, last_active, invited_by";

// Build the newest-first keyset SELECT. Every free-text value travels as a bound
// $var (never spliced into the body); the datetime cursor is cast with
// type::datetime; the validated integer limit is inlined. It is a keyset walk —
// `created_at < $cursor ORDER BY created_at DESC LIMIT n` — never an OFFSET/START
// deep-page.
export const buildUserListKeysetSql = (
  input: UserListFilter
): UserListKeysetSql => {
  const filter = userListFilterSchema.parse(input);
  const terms: string[] = [];
  const vars: Record<string, string> = {};
  if (filter.status !== undefined) {
    terms.push("status = $status");
    vars.status = filter.status;
  }
  if (filter.role !== undefined) {
    terms.push("role = $role");
    vars.role = filter.role;
  }
  if (filter.invitedBy !== undefined) {
    terms.push("invited_by = $invited_by");
    vars.invited_by = filter.invitedBy;
  }
  if (filter.search !== undefined) {
    terms.push(
      "(string::contains(email, $search) OR string::contains(name ?? '', $search))"
    );
    vars.search = filter.search;
  }
  if (filter.cursor !== undefined) {
    terms.push("created_at < type::datetime($cursor)");
    vars.cursor = filter.cursor;
  }
  const where = terms.length > 0 ? ` WHERE ${terms.join(" AND ")}` : "";
  const query = `SELECT ${LIST_PROJECTION} FROM user${where} ORDER BY created_at DESC LIMIT ${filter.limit};`;
  return { query, vars };
};

// A guard proving the read is an index-backed keyset walk: it orders + limits and
// never deep-pages via OFFSET/START.
const KEYSET_ORDER_RE = /\bORDER\s+BY\s+created_at\b/i;
const KEYSET_LIMIT_RE = /\bLIMIT\b/i;
const KEYSET_OFFSET_RE = /\b(?:OFFSET|START)\b/i;
export const isKeysetUserListRead = (query: string): boolean =>
  KEYSET_ORDER_RE.test(query) &&
  KEYSET_LIMIT_RE.test(query) &&
  !KEYSET_OFFSET_RE.test(query);

// Map a raw SurrealDB row into a validated list entry. Extracts the bare id from
// a `user:<id>` record id and normalizes the datetimes to strings. Parsing
// through the projection schema means a drifted/oversized row can never surface.
const idFromRecord = (raw: unknown): string => {
  const value =
    typeof raw === "string" ? raw : ((raw as { id?: string } | null)?.id ?? "");
  const key = value.includes(":")
    ? value.slice(value.lastIndexOf(":") + 1)
    : value;
  return key.replace(/[⟨⟩`]/g, "");
};

const asString = (raw: unknown): string | undefined => {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  return;
};

export const mapUserListRow = (raw: Record<string, unknown>): UserListEntry =>
  userListEntrySchema.parse({
    id: idFromRecord(raw.id),
    email: raw.email,
    name: typeof raw.name === "string" ? raw.name : undefined,
    role: raw.role,
    status: raw.status,
    created_at: asString(raw.created_at) ?? "",
    last_active: asString(raw.last_active),
    invited_by: typeof raw.invited_by === "string" ? raw.invited_by : undefined,
  });

// --- The role-assignment authority (the escalation core) ---------------------

type Tier = "member" | "admin" | "superadmin";
const APP_TIER_RANK: Record<Tier, number> = {
  member: 0,
  admin: 1,
  superadmin: 2,
};

// The highest tier a comma-split GLOBAL role claim resolves to (defaults to the
// lowest tier). The escalation check keys on the actor's HIGHEST tier so a
// multi-role claim cannot dodge the hierarchy.
const highestTier = (roleClaim: string): Tier => {
  let best: Tier = "member";
  for (const tier of resolveGlobalRoles({ user: { role: roleClaim } })) {
    if (
      (tier === "member" || tier === "admin" || tier === "superadmin") &&
      APP_TIER_RANK[tier] > APP_TIER_RANK[best]
    ) {
      best = tier;
    }
  }
  return best;
};

export type RoleAssignmentVerdict =
  | "ok"
  | "forbidden-not-superadmin"
  | "forbidden-self-target"
  | "forbidden-escalation"
  | "invalid-role";

export interface RoleAssignmentRequest {
  readonly actorRole: string;
  readonly actorUserId: string;
  readonly requestedRole: string;
  readonly targetUserId: string;
}

// The pure role-assignment decision — the server authority that rejects every API
// escalation regardless of client state. Order is deliberate:
//   1. an out-of-vocabulary requested role is rejected (invalid-role),
//   2. only a role-assignment tier (superadmin) may assign at all (not-superadmin),
//   3. the actor can never target its OWN row (self-target),
//   4. the numeric hierarchy forbids assigning at/above the actor's tier
//      (escalation) — which is exactly why `superadmin` is never assignable, so a
//      second superadmin can never be minted through the API.
export const evaluateRoleAssignment = (
  request: RoleAssignmentRequest
): RoleAssignmentVerdict => {
  const parsed = appRoleSchema.safeParse(request.requestedRole);
  if (!parsed.success) {
    return "invalid-role";
  }
  const requested = parsed.data;
  const actorTier = highestTier(request.actorRole);
  const authorityTiers = new Set<Tier>(roleAssignmentTiers());
  if (!authorityTiers.has(actorTier)) {
    return "forbidden-not-superadmin";
  }
  if (request.targetUserId === request.actorUserId) {
    return "forbidden-self-target";
  }
  if (!canAssignRole(actorTier, requested)) {
    return "forbidden-escalation";
  }
  return "ok";
};

// --- The reversible (soft) deactivate builders -------------------------------

// A record-id key charset conservative enough to inline safely into a
// type::record var-bound target (better-auth ids are alphanumeric + `-`/`_`).
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface StatusUpdateSql {
  readonly query: string;
  readonly vars: Record<string, string>;
}

// Build the soft status flip. It is an UPDATE (never a DELETE/REMOVE): the row
// survives, so a deactivate is fully reversible. The status is a closed-set enum
// literal (safe to inline); the user id travels as a bound $var.
export const buildSetStatusSql = (
  userId: string,
  status: UserStatus
): StatusUpdateSql => {
  if (!SAFE_ID_RE.test(userId)) {
    throw new Error("user id must be a safe record-id key");
  }
  const validStatus = userStatusSchema.parse(status);
  return {
    query: `UPDATE type::record('user', $id) SET status = '${validStatus}' RETURN AFTER;`,
    vars: { id: userId },
  };
};

export const buildDeactivateSql = (userId: string): StatusUpdateSql =>
  buildSetStatusSql(userId, "deactivated");

export const buildReactivateSql = (userId: string): StatusUpdateSql =>
  buildSetStatusSql(userId, "active");

// Build the role flip (the superadmin-only role assignment applied server-side). It
// is an UPDATE (the row survives); the requested role is a closed-set enum literal
// (re-validated through the identity schema, so it is safe to inline), and the user
// id travels as a bound $var. It is NOT a hard delete, so `isSoftDeleteSql` on a
// generated role flip is irrelevant — the escalation authority (evaluateRoleAssignment)
// is what gates WHICH role may be stamped; this only renders the accepted flip.
export const buildSetRoleSql = (
  userId: string,
  role: AppRole
): StatusUpdateSql => {
  if (!SAFE_ID_RE.test(userId)) {
    throw new Error("user id must be a safe record-id key");
  }
  const validRole = appRoleSchema.parse(role);
  return {
    query: `UPDATE type::record('user', $id) SET role = '${validRole}' RETURN AFTER;`,
    vars: { id: userId },
  };
};

// Build the target-session revocation: DELETE the target user's session rows. This
// is the CLOUD-surface revocation (the session store the gatekeeper owns). The
// LOCAL-surface revocation rides the existing revocation signal the local daemon
// already consumes; this builder covers only the cloud session store. The user id
// travels as a bound $var, never spliced into the statement body.
export const buildRevokeUserSessionsSql = (userId: string): StatusUpdateSql => {
  if (!SAFE_ID_RE.test(userId)) {
    throw new Error("user id must be a safe record-id key");
  }
  return {
    query: "DELETE session WHERE userId = $uid;",
    vars: { uid: userId },
  };
};

// A guard proving the deactivate is a SOFT delete: it UPDATEs the status field and
// never issues a hard DELETE/REMOVE. A builder that ever emitted a hard delete
// would fail this (the mutation twin proves it can fail).
const HARD_DELETE_RE = /\b(?:DELETE|REMOVE)\b/i;
const UPDATE_STATUS_RE = /\bUPDATE\b[\s\S]*\bSET\s+status\b/i;
export const isSoftDeleteSql = (query: string): boolean =>
  UPDATE_STATUS_RE.test(query) && !HARD_DELETE_RE.test(query);

// --- The context-injected user-admin router ----------------------------------

interface UserAdminSession {
  readonly id: string;
  readonly user: { readonly id: string; readonly role: string };
}

export interface UserAdminContext {
  // The privileged SurrealDB forwarders the host wires (they run the keyset SELECT
  // and the scoped writes through the system credential). Injected so the
  // authorization decisions are exercised without a live DB.
  readonly listUsers: (
    input: UserListFilter
  ) => Promise<readonly UserListEntry[]>;
  // Injected clock so the step-up TTL boundary is driven deterministically.
  readonly now: number;
  // Appends the consequent admin-action audit event. Forwarder-backed on the served
  // surface (a real append), so it is awaited and returns a promise; the resolver
  // resolves it fail-closed via `requireSink` BEFORE the mutation, so a privileged
  // mutation can never proceed without its audit wired.
  readonly recordConsequentAudit: (event: {
    readonly actor: string;
    readonly action: string;
    readonly target?: string;
  }) => Promise<void> | void;
  // A failed step-up routes through the SAME shared per-subject lockout seam as a
  // failed login (one counter).
  readonly recordLockoutFailure: (subject: string) => void;
  // Audit is outermost: every step-up attempt records actor/action/outcome, and a
  // granted mutation ALSO audits its consequent action against the target. Resolved
  // fail-closed via `requireSink` at the top of the step-up gate.
  readonly recordStepUpAudit: (event: {
    readonly action: DangerousAction;
    readonly actor: string;
    readonly outcome: "granted" | "challenged" | "rejected";
  }) => Promise<void> | void;
  // The ACTOR session-revoke seam a step-up FAILURE must NEVER call — a cancel /
  // fail-twice aborts only the action, never the session. Present so a test can
  // prove it stays untouched (distinct from revokeUserSessions, which targets the
  // affected user's sessions on a SUCCESSFUL mutation).
  readonly revokeSession: (sessionId: string) => void;
  // Revoke the TARGET user's sessions across BOTH surfaces (cloud + local).
  readonly revokeUserSessions: (input: {
    readonly userId: string;
    readonly surfaces: readonly RevocationSurface[];
  }) => Promise<void> | void;
  readonly session: UserAdminSession | null;
  readonly setUserRole: (input: {
    readonly userId: string;
    readonly role: AppRole;
  }) => Promise<void> | void;
  readonly setUserStatus: (input: {
    readonly userId: string;
    readonly status: UserStatus;
  }) => Promise<void> | void;
  // The server-side single-use step-up grant store (server-verification +
  // consumption) and the presented grant token (context-threaded, since
  // middleware runs BEFORE `.input()`).
  readonly stepUpStore: StepUpGrantStore;
  readonly stepUpToken?: string;
}

const GENERIC_FORBIDDEN = "Insufficient role for this scope";

// Throw the nearest native FORBIDDEN carrying STEP_UP_REQUIRED in shape.data.code.
const stepUpRequired = (): never => {
  throw new TRPCError({
    cause: { code: "STEP_UP_REQUIRED" },
    code: "FORBIDDEN",
    message: "Step-up re-authentication required for this action",
  });
};

// The structural subset of the unified context the step-up decision reads. The
// audit/lockout recorders are optional (a tier that has not wired them records
// nothing rather than throwing — the step-up gate itself still fails closed); the
// grant store is required at use through `requireSink`, so a tier with no store
// challenges rather than silently granting.
interface StepUpConsumeCtx {
  readonly now?: number;
  readonly recordLockoutFailure?: UserAdminContext["recordLockoutFailure"];
  readonly recordStepUpAudit?: UserAdminContext["recordStepUpAudit"];
  readonly session: UserAdminSession | null;
  readonly stepUpStore?: StepUpGrantStore;
  readonly stepUpToken?: string;
}

// The step-up decision, shared by the guarded mutations. Audits every attempt and
// throws STEP_UP_REQUIRED on the challenge/rejection; on a rejection it also routes
// through the shared lockout seam. It NEVER touches the actor's session. Returns
// only on a granted, freshly-consumed grant.
//
// The step-up audit sink is resolved fail-closed (`requireSink`) up front, so a
// dangerous mutation can never proceed — or even be challenged — without its step-up
// audit wired: the served surface fails closed on a missing audit sink exactly as it
// does on a missing data sink (symmetric, never an audit fail-open). The session gate
// still runs first, so UNAUTHORIZED precedes the sink guard.
const consumeStepUp = async (
  ctx: StepUpConsumeCtx,
  action: DangerousAction
): Promise<void> => {
  if (!ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }
  const actor = ctx.session.user.id;
  const recordStepUpAudit = requireSink(
    ctx.recordStepUpAudit,
    "recordStepUpAudit"
  );
  if (ctx.stepUpToken === undefined) {
    await recordStepUpAudit({ action, actor, outcome: "challenged" });
    stepUpRequired();
  }
  const store = requireSink(ctx.stepUpStore, "stepUpStore");
  const result = store.verifyAndConsume({
    action,
    now: ctx.now ?? Date.now(),
    sessionId: ctx.session.id,
    token: ctx.stepUpToken,
  });
  if (!result.granted) {
    await recordStepUpAudit({ action, actor, outcome: "rejected" });
    ctx.recordLockoutFailure?.(actor);
    stepUpRequired();
  }
  await recordStepUpAudit({ action, actor, outcome: "granted" });
};

// Session-only base: narrows the session non-null for downstream legs.
const sessionProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});

// Admin-surface gate: admin/superadmin only (the checkpoint's `user:list` hinge),
// keyed on the GLOBAL role claim. A below-admin session is denied FORBIDDEN with
// the generic neutral message (no role enumeration).
const adminProcedure = sessionProcedure.use(({ ctx, next }) => {
  if (!holdsAdminSurface(ctx.session.user.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: GENERIC_FORBIDDEN });
  }
  return next();
});

// Superadmin gate for role assignment: only a tier holding the matrix's
// `user:set-role` capability (superadmin) may reach the role-change surface, so a
// non-superadmin is denied FORBIDDEN and NEVER reaches the step-up challenge.
const superadminProcedure = sessionProcedure.use(({ ctx, next }) => {
  const authorityTiers = new Set<string>(roleAssignmentTiers());
  const holds = resolveGlobalRoles({
    user: { role: ctx.session.user.role },
  }).some((tier) => authorityTiers.has(tier));
  if (!holds) {
    throw new TRPCError({ code: "FORBIDDEN", message: GENERIC_FORBIDDEN });
  }
  return next();
});

const roleChangeInput = z.object({
  targetUserId: z.string().min(1),
  role: appRoleSchema,
});

const targetInput = z.object({ targetUserId: z.string().min(1) });

// The dangerous-action map this router wires (the coverage gate probes each to
// prove it is step-up-guarded). Role change lands `role.change`; deactivate lands
// the reserved `user.ban` action (a deactivate IS the ban — now guarded).
export const USER_ADMIN_STEP_UP_PROCEDURES = {
  changeRole: "role.change",
  deactivateUser: "user.ban",
} as const satisfies Record<string, DangerousAction>;

export const userAdminRouter = t.router({
  // The admin-tier keyset user list (never OFFSET). A member is denied at the
  // admin gate; an admin/superadmin reads the keyset page through the injected
  // forwarder — absent on a tier with no SurrealDB binding, so the read FAILS CLOSED
  // (throws) rather than returning an empty page a client could misread as authorized.
  listUsers: adminProcedure
    .input(userListFilterSchema)
    .query(async ({ ctx, input }) => ({
      users: await requireSink(ctx.listUsers, "listUsers")(input),
    })),

  // Superadmin-only role assignment, step-up-guarded. A non-superadmin is denied
  // FORBIDDEN at the superadmin gate (never reaches step-up); a superadmin is
  // challenged for step-up; on a fresh grant the resolver authorizes the specific
  // (target, role) — rejecting every escalation — then applies it, revokes the
  // TARGET's sessions across both surfaces, and audits `admin.role_change`.
  changeRole: superadminProcedure
    .use(async ({ ctx, next }) => {
      await consumeStepUp(ctx, "role.change");
      return next({ ctx: { ...ctx, session: ctx.session } });
    })
    .input(roleChangeInput)
    .mutation(async ({ ctx, input }) => {
      const verdict = evaluateRoleAssignment({
        actorRole: ctx.session.user.role,
        actorUserId: ctx.session.user.id,
        requestedRole: input.role,
        targetUserId: input.targetUserId,
      });
      if (verdict !== "ok") {
        throw new TRPCError({
          cause: { code: "ROLE_ASSIGNMENT_FORBIDDEN" },
          code: verdict === "invalid-role" ? "BAD_REQUEST" : "FORBIDDEN",
          message: GENERIC_FORBIDDEN,
        });
      }
      // Fail-closed audit-sink check BEFORE the mutation: a role change can never
      // mutate without its consequent audit wired (resolved after the authorization
      // verdict, so a forbidden escalation is still FORBIDDEN, not a sink-guard leak).
      const recordConsequentAudit = requireSink(
        ctx.recordConsequentAudit,
        "recordConsequentAudit"
      );
      await requireSink(
        ctx.setUserRole,
        "setUserRole"
      )({
        role: input.role,
        userId: input.targetUserId,
      });
      await requireSink(
        ctx.revokeUserSessions,
        "revokeUserSessions"
      )({
        surfaces: REVOCATION_SURFACES,
        userId: input.targetUserId,
      });
      await recordConsequentAudit({
        action: "admin.role_change",
        actor: ctx.session.user.id,
        target: input.targetUserId,
      });
      return { changed: true, status: "role-changed" as const };
    }),

  // Reversible deactivate: admin-gated + step-up-guarded. On a fresh grant it soft-
  // flips the target's status to `deactivated` (never a hard delete), revokes the
  // target's sessions across both surfaces, and audits `admin.user_deactivated`. A
  // deactivate can never target the actor's own row (no self-lockout).
  deactivateUser: adminProcedure
    .use(async ({ ctx, next }) => {
      await consumeStepUp(ctx, "user.ban");
      return next({ ctx: { ...ctx, session: ctx.session } });
    })
    .input(targetInput)
    .mutation(async ({ ctx, input }) => {
      if (input.targetUserId === ctx.session.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: GENERIC_FORBIDDEN });
      }
      // Fail-closed audit-sink check BEFORE the soft flip: a deactivate can never
      // mutate without its consequent audit wired (after the self-target FORBIDDEN).
      const recordConsequentAudit = requireSink(
        ctx.recordConsequentAudit,
        "recordConsequentAudit"
      );
      await requireSink(
        ctx.setUserStatus,
        "setUserStatus"
      )({
        status: "deactivated",
        userId: input.targetUserId,
      });
      await requireSink(
        ctx.revokeUserSessions,
        "revokeUserSessions"
      )({
        surfaces: REVOCATION_SURFACES,
        userId: input.targetUserId,
      });
      await recordConsequentAudit({
        action: "admin.user_deactivated",
        actor: ctx.session.user.id,
        target: input.targetUserId,
      });
      return { deactivated: true };
    }),

  // Reactivate restores access: admin-gated + audited. A soft flip back to
  // `active`; no session revoke (it grants access rather than withdrawing it).
  reactivateUser: adminProcedure
    .input(targetInput)
    .mutation(async ({ ctx, input }) => {
      // Fail-closed audit-sink check BEFORE the soft flip back: a reactivate can
      // never mutate without its consequent audit wired.
      const recordConsequentAudit = requireSink(
        ctx.recordConsequentAudit,
        "recordConsequentAudit"
      );
      await requireSink(
        ctx.setUserStatus,
        "setUserStatus"
      )({
        status: "active",
        userId: input.targetUserId,
      });
      await recordConsequentAudit({
        action: "admin.user_reactivated",
        actor: ctx.session.user.id,
        target: input.targetUserId,
      });
      return { reactivated: true };
    }),
});

export const createUserAdminCaller = (ctx: UserAdminContext) =>
  userAdminRouter.createCaller(ctx);
