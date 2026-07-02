import {
  CHANGE_PASSWORD_PATH,
  evaluateForcedPasswordChange,
} from "@perry-starter/auth/forced-password-change";
import {
  holdsAdminSurface,
  resolveGlobalRoles,
  roles,
} from "@perry-starter/auth/rbac";
import type { DangerousAction } from "@perry-starter/auth/step-up";
import type { StepUpGrantStore } from "@perry-starter/auth/step-up-store";
import {
  evaluateCredentialChain,
  TWO_FACTOR_CHALLENGE_PATH,
  TWO_FACTOR_ENROL_PATH,
} from "@perry-starter/auth/two-factor-enrolment";
import { initTRPC, TRPCError } from "@trpc/server";

import type { Context } from "./context";
import { requireSink } from "./fail-closed";
import { lockoutDataForError } from "./lockout-envelope";

// The shipped root tRPC instance — the ONE served surface (the mounted admin /
// audit / step-up / invitation sub-routers all build on it). Its errorFormatter
// folds two projections into shape.data:
//   - the precise error code from the cause (STEP_UP_REQUIRED / ROLE_ASSIGNMENT_*
//     / ADMIN_BACKEND_UNAVAILABLE / … are NOT native tRPC codes, so the nearest
//     native code is thrown and the precise code rides shape.data.code), and
//   - the progressive-lockout projection (ACCOUNT_LOCKED + retryAfter) for a
//     genuine lockout cause — so `buildLockoutError` surfaces the account-locked
//     envelope the client already consumes. lockoutDataForError is folded LAST so a
//     real lockout keeps ACCOUNT_LOCKED + retryAfter; every other error carries its
//     precise cause code. There is no separate per-leg tRPC instance.
export const t = initTRPC.context<Context>().create({
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: {
      ...shape.data,
      code: adCodeForError(error) ?? shape.data.code,
      ...lockoutDataForError(error),
    },
  }),
});

export const router = t.router;

export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
      cause: "No session",
    });
  }
  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
    },
  });
});

// The admin-tier (role-gated) procedure — the tRPC leg of the admin-surface
// authorization, mirrored by the SurrealDB row PERMISSIONS. Layered on the session
// check, it admits ONLY a GLOBAL role the ONE matrix grants the admin-surface
// `user:list` capability (admin/superadmin); a member is denied FORBIDDEN with the
// generic neutral message (no role enumeration). Both this leg and the checkpoint
// call `holdsAdminSurface`, so an admin page's data path is role-gated at the same
// matrix decision the checkpoint uses — never an auth-only tier.
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  const role = (ctx.session.user as { role?: string }).role ?? "";
  if (!holdsAdminSurface(role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Insufficient role for this scope",
    });
  }
  return next();
});

// --- The tRPC RBAC middleware leg (the first authorization layer) ------------
//
// It authorizes against the ONE single-sourced matrix in @perry-starter/auth,
// reading the GLOBAL admin-plugin role claim (user.role) split on ',' — never an
// org-structural role. A denial throws the nearest native tRPC code (FORBIDDEN)
// and carries the precise code in shape.data.code via the errorFormatter.
// This leg is necessary but NOT sufficient — the SurrealDB row-level PERMISSIONS
// (generated from the same matrix) are the second leg; neither alone grants.

interface RbacContext {
  readonly session: {
    readonly user: { readonly id: string; readonly role: string };
  } | null;
}

interface AuthorizingRole {
  readonly authorize: (
    request: Record<string, readonly string[]>,
    connector?: "AND" | "OR"
  ) => { readonly success: boolean };
}
const ROLES = roles as unknown as Record<string, AuthorizingRole | undefined>;

// The cross-user oversight capability: reading another user's resources requires
// the admin tier's `user:list` capability, which member lacks and admin/superadmin
// hold. Derived from the single matrix, so it cannot drift from the row leg.
const CROSS_USER_READ = { user: ["list"] } as const;

// The error envelope: SESSION_EXPIRED / ACCOUNT_LOCKED etc. are NOT valid TRPCError
// codes, so the precise code rides in shape.data.code. For an authorization denial
// the precise code IS the native FORBIDDEN; a richer denial may attach its own
// code via the error cause.
const adCodeForError = (error: unknown): string | undefined => {
  if (error instanceof TRPCError) {
    const cause = error.cause as { code?: string } | undefined;
    return cause?.code ?? error.code;
  }
  return;
};

const tRbac = initTRPC.context<RbacContext>().create({
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: { ...shape.data, code: adCodeForError(error) ?? shape.data.code },
  }),
});

// Allow iff ANY resolved GLOBAL tier grants the capability; multi-role claims
// ("admin,member") are split on ','.
const authorizeGlobalRole = (
  request: Record<string, readonly string[]>,
  roleClaim: string
): boolean =>
  resolveGlobalRoles({ user: { role: roleClaim } }).some((tier) => {
    const role = ROLES[tier];
    return role ? role.authorize(request, "AND").success : false;
  });

// The RBAC .use() leg, layered on a session check; it runs BEFORE input parsing.
const rbacProcedure = (request: Record<string, readonly string[]>) =>
  tRbac.procedure.use(({ ctx, next }) => {
    if (!ctx.session) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }
    if (!authorizeGlobalRole(request, ctx.session.user.role)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Insufficient role for this scope",
      });
    }
    return next();
  });

const crossUserReadRouter = tRbac.router({
  // Reading a document outside the caller's own scope is a cross-user oversight
  // action — denied for member, granted for admin/superadmin.
  readForeignDocument: rbacProcedure(CROSS_USER_READ).query(() => ({
    id: "documents:foreign",
  })),
});

// An in-process caller for the cross-user read path (no network), exercising the
// middleware leg's deny/allow decision directly.
export const createCrossUserReadCaller = (ctx: RbacContext) =>
  crossUserReadRouter.createCaller(ctx);

// Project a thrown error into its native tRPC code + the precise shape.data.code.
export const toErrorShape = (
  error: unknown
): { readonly dataCode?: string; readonly nativeCode?: string } => {
  if (error instanceof TRPCError) {
    return { nativeCode: error.code, dataCode: adCodeForError(error) };
  }
  return {};
};

// --- The forced-password-change gate middleware (the backend signal) ---------
//
// A `requirePasswordChange`-flagged account is blocked from EVERY tRPC op except
// change-password. The middleware consumes the pure gate decision, emits the
// x-require-password-change signal header on the response leg (so the frontend
// can mount its non-dismissable gate), and throws the nearest native FORBIDDEN
// carrying PASSWORD_CHANGE_REQUIRED in shape.data.code (it is NOT a native tRPC
// code). The flag's session projection is wired on the worker host; here the
// middleware reads it off the session context, exactly as the RBAC leg reads the
// role claim. The gate ALWAYS leaves the change-password op open, so a flagged
// account is never a dead-end.

interface ForcedChangeContext {
  readonly resHeaders?: Headers;
  readonly session: {
    readonly user: {
      readonly id: string;
      readonly requirePasswordChange: boolean;
    };
  } | null;
}

const tForcedChange = initTRPC.context<ForcedChangeContext>().create({
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: { ...shape.data, code: adCodeForError(error) ?? shape.data.code },
  }),
});

// A procedure bound to its gate path: the middleware evaluates the flag against
// THAT path, so the change-password op is permitted while every other op is
// denied for a flagged account.
const forcedChangeProcedure = (gatePath: string) =>
  tForcedChange.procedure.use(({ ctx, next }) => {
    if (!ctx.session) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }
    const verdict = evaluateForcedPasswordChange({
      path: gatePath,
      requirePasswordChange: ctx.session.user.requirePasswordChange,
    });
    if (!verdict.allow) {
      ctx.resHeaders?.set(verdict.signalHeader, "1");
      throw new TRPCError({
        cause: { code: verdict.code },
        code: "FORBIDDEN",
        message: "Password change required before any other operation",
      });
    }
    return next();
  });

const forcedChangeRouter = tForcedChange.router({
  // The ONE permitted op while flagged — always a forward path.
  changePassword: forcedChangeProcedure(CHANGE_PASSWORD_PATH).mutation(() => ({
    changed: true,
  })),
  // A representative blocked op — denied for a flagged account.
  listDocuments: forcedChangeProcedure("documents.list").query(() => ({
    documents: [] as const,
  })),
});

// In-process caller exercising the forced-change middleware's deny/allow decision
// directly (no network), mirroring the cross-user-read caller.
export const createForcedChangeCaller = (ctx: ForcedChangeContext) =>
  forcedChangeRouter.createCaller(ctx);

// --- The mandatory-2FA credential-chain gate middleware ----------------------
//
// After a forced password change, an admin/superadmin is deterministically chained
// through mandatory TOTP enrolment: NO admin/superadmin can reach a privileged op
// without 2FA. The ordered, non-dismissable chain (PASSWORD_CHANGE_REQUIRED ->
// forced TOTP enrol -> allow) is the pure decision in @perry-starter/auth; this
// leg binds it to the session and carries the precise gate code in shape.data.code
// (TWO_FACTOR_REQUIRED / PASSWORD_CHANGE_REQUIRED are NOT native tRPC codes). Each
// gate leaves exactly ONE forward path open, so an admin is driven to enrolment
// but can never skip a step to operate.

interface CredentialChainContext {
  readonly session: {
    readonly user: {
      readonly id: string;
      readonly role: string;
      readonly requirePasswordChange: boolean;
      readonly twoFactorEnrolled: boolean;
    };
  } | null;
}

const tCredentialChain = initTRPC.context<CredentialChainContext>().create({
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: { ...shape.data, code: adCodeForError(error) ?? shape.data.code },
  }),
});

const credentialChainProcedure = (gatePath: string) =>
  tCredentialChain.procedure.use(({ ctx, next }) => {
    if (!ctx.session) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }
    const verdict = evaluateCredentialChain({
      path: gatePath,
      requirePasswordChange: ctx.session.user.requirePasswordChange,
      roleClaim: ctx.session.user.role,
      twoFactorEnrolled: ctx.session.user.twoFactorEnrolled,
    });
    if (!verdict.allow) {
      throw new TRPCError({
        cause: { code: verdict.gate },
        code: "FORBIDDEN",
        message: "Credential enrolment required before this operation",
      });
    }
    return next();
  });

const credentialChainRouter = tCredentialChain.router({
  // The forced-change forward path — permitted only while a password change is owed.
  changePassword: credentialChainProcedure(CHANGE_PASSWORD_PATH).mutation(
    () => ({ changed: true })
  ),
  // The mandatory-TOTP forward paths — the only ops open while TWO_FACTOR_REQUIRED.
  enrolTwoFactor: credentialChainProcedure(TWO_FACTOR_ENROL_PATH).mutation(
    () => ({ enrolled: true })
  ),
  verifyTwoFactor: credentialChainProcedure(TWO_FACTOR_CHALLENGE_PATH).mutation(
    () => ({ verified: true })
  ),
  // A representative privileged op — refused for an admin/superadmin until the
  // full chain (password change + TOTP enrolment) is satisfied.
  listUsers: credentialChainProcedure("admin.listUsers").query(() => ({
    users: [] as const,
  })),
});

// In-process caller exercising the credential-chain middleware's deny/allow
// decision directly (no network).
export const createCredentialChainCaller = (ctx: CredentialChainContext) =>
  credentialChainRouter.createCaller(ctx);

// --- The per-action step-up gate (dangerous mutations) ------------------------
//
// A dangerous mutation (role change, invitation creation, and the reserved future
// ban/impersonate set) must not proceed on a stale or replayed re-auth. This gate
// requires a FRESH, SINGLE-USE, SHORT-TTL, SERVER-VERIFIED grant bound to
// (session, action): a prior step-up success never satisfies a later or different
// action. The presented grant token is read off the CONTEXT (header-threaded on the
// real host), because middleware runs BEFORE `.input()` parsing — so the token can
// never ride in the validated input. STEP_UP_REQUIRED is NOT a native tRPC code, so
// the nearest native FORBIDDEN is thrown and the precise code rides in
// shape.data.code via the errorFormatter.
//
// Fail-closed + session-safe: with no token the gate CHALLENGES; with an invalid
// token it re-challenges (or, past the fail-twice ceiling, aborts the ACTION) and
// records the failure through the SHARED per-subject lockout seam — but it NEVER
// revokes the session on any failure/abort path. Audit is outermost: every attempt
// (challenge / granted / rejected) writes actor/action/outcome, and a granted
// mutation ALSO audits its consequent action, so no privileged path is fail-open.

// The append-only step-up attempt event (actor, action, outcome). The host maps the
// outcome onto the audit vocabulary action `auth.step_up_<outcome>`.
export interface StepUpAuditEvent {
  readonly action: DangerousAction;
  readonly actor: string;
  readonly outcome: "granted" | "challenged" | "rejected";
}

export interface StepUpContext {
  // Injected clock so the TTL boundary is driven deterministically.
  readonly now: number;
  // The consequent-action audit the guarded resolver emits on success. Forwarder-
  // backed on the served surface, so it is awaited; resolved fail-closed via
  // `requireSink` before the resolver's effect.
  readonly recordConsequentAudit: (event: {
    readonly actor: string;
    readonly action: string;
  }) => Promise<void> | void;
  // The SHARED per-subject lockout-recording seam (a failed step-up routes to the
  // same counter as a failed login). The DO-backed increment behind it is deferred.
  readonly recordLockoutFailure: (subject: string) => void;
  // Injected audit sink — every attempt records through it (audit outermost).
  readonly recordStepUpAudit: (event: StepUpAuditEvent) => Promise<void> | void;
  // The session-revoke seam the step-up path must NEVER call — cancel/fail-twice
  // abort ONLY the action, never the session. Present so a test can prove it stays
  // untouched.
  readonly revokeSession: (sessionId: string) => void;
  // The server-resolved session. `id` is the session identity the grant binds to
  // (a grant for one session is rejected for another); `user.id` is the account
  // subject the lockout seam + audit actor key on.
  readonly session: {
    readonly id: string;
    readonly user: { readonly id: string; readonly role: string };
  } | null;
  // The server-side single-use grant store (server-verification + consumption).
  readonly stepUpStore: StepUpGrantStore;
  // The presented grant token (context-threaded; absent = the initial challenge).
  readonly stepUpToken?: string;
}

// Throw the nearest native code carrying STEP_UP_REQUIRED in shape.data.code.
const stepUpRequired = (): never => {
  throw new TRPCError({
    cause: { code: "STEP_UP_REQUIRED" },
    code: "FORBIDDEN",
    message: "Step-up re-authentication required for this action",
  });
};

// The composable step-up gate, bound to its dangerous action. Built on the ONE
// shared `t` so it mounts into the single served router. Layered on a session check
// AND the admin-surface role gate (these live-mounted legs are classified `admin` in
// the procedure-tier manifest, so a below-admin session is denied FORBIDDEN before
// the step-up challenge — matching the tier map, no capability enumeration). Runs
// BEFORE input parsing. On grant it narrows the session non-null for the resolver.
// The step-up audit sink is resolved fail-closed (`requireSink`) up front, so a
// dangerous mutation can never proceed — or be challenged — without its step-up audit
// wired; the grant store is likewise required at use, so a tier with no store
// CHALLENGES rather than silently granting.
const stepUpGuardedProcedure = (action: DangerousAction) =>
  t.procedure.use(async ({ ctx, next }) => {
    if (!ctx.session) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }
    if (!holdsAdminSurface(ctx.session.user.role)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Insufficient role for this scope",
      });
    }
    const actor = ctx.session.user.id;
    const recordStepUpAudit = requireSink(
      ctx.recordStepUpAudit,
      "recordStepUpAudit"
    );

    // No token → the initial challenge (not a lockout failure). Audited, then
    // STEP_UP_REQUIRED raises the modal.
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
      // A presented-but-invalid grant is a FAILURE: audit it and record through the
      // shared lockout seam. Whether it re-challenges or (fail-twice) aborts the
      // action, the SESSION is never touched.
      await recordStepUpAudit({ action, actor, outcome: "rejected" });
      ctx.recordLockoutFailure?.(actor);
      stepUpRequired();
    }

    await recordStepUpAudit({ action, actor, outcome: "granted" });
    return next({ ctx: { ...ctx, session: ctx.session } });
  });

// A session-only (non-step-up) guard for a benign op — proving a non-dangerous
// mutation needs no step-up grant.
const stepUpSessionProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});

export const stepUpRouter = t.router({
  // Role change (a representative dangerous mutation) — admin-gated + step-up-guarded.
  // On success it audits its consequent action (resolved fail-closed BEFORE the
  // write), so a granted mutation writes TWO events (grant + action).
  changeRole: stepUpGuardedProcedure("role.change").mutation(
    async ({ ctx }) => {
      const recordConsequentAudit = requireSink(
        ctx.recordConsequentAudit,
        "recordConsequentAudit"
      );
      await recordConsequentAudit({
        action: "admin.role_change",
        actor: ctx.session.user.id,
      });
      return { changed: true };
    }
  ),
  // Invitation creation (a representative dangerous mutation) — admin-gated +
  // step-up-guarded.
  createInvitation: stepUpGuardedProcedure("invite.create").mutation(
    async ({ ctx }) => {
      const recordConsequentAudit = requireSink(
        ctx.recordConsequentAudit,
        "recordConsequentAudit"
      );
      await recordConsequentAudit({
        action: "admin.invitation_created",
        actor: ctx.session.user.id,
      });
      return { invited: true };
    }
  ),
  // A benign, non-dangerous op — needs NO step-up grant.
  readSettings: stepUpSessionProcedure.query(() => ({ settings: [] as const })),
});

// The dangerous router procedures + the (session, action) each binds to. The
// coverage gate probes each to prove it is step-up-guarded; drift between this map
// and the wired procedures is caught by the gate.
export const STEP_UP_PROCEDURES = {
  changeRole: "role.change",
  createInvitation: "invite.create",
} as const satisfies Record<string, DangerousAction>;

export const createStepUpCaller = (ctx: StepUpContext) =>
  stepUpRouter.createCaller(ctx);
