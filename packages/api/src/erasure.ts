// The self-service GDPR erasure request — soft-delete + scheduled crypto-shred,
// behind a per-action step-up.
//
// better-auth's delete is HARD-only (blocked upstream by the beforeDelete hook), so
// erasure here is a SOFT flip: the caller's OWN account row is tombstoned (status ->
// deactivated, deletedAt / erasureRequestedAt stamped) via an UPDATE — NEVER a DB
// DELETE — so it is recoverable until the deferred crypto-shred. The subject is then
// registered in the fourth-key-class crypto-shred registry, and the erasure
// event is written to the immutable audit log. Every write fails closed
// (`requireSink`) on a tier with no forwarder/audit wired.
//
// STEP-UP (single-use, per-action): the request must present a FRESH, single-use,
// (session, `user.erasure`)-bound step-up grant. A prior grant minted for another
// action (role change, invite, …) does NOT satisfy this — the store binds each grant
// to its action and consumes it once. This is the SELF-service leg, so it is NOT
// admin-gated (any authenticated member may erase their own account); the scope is
// the SERVER-derived `session.user.id`, never a client-supplied id.
//
// SESSION-SAFE: a cancelled or rejected (even fail-twice) step-up aborts ONLY the
// erasure action — the session is NEVER revoked. The revoke seam is present in the
// context but this module never calls it, so a test can prove it stays untouched.

import type { DangerousAction } from "@perry-starter/auth/step-up";
import type { StepUpGrantStore } from "@perry-starter/auth/step-up-store";
import { TRPCError } from "@trpc/server";

import type { AdminForward } from "./admin-sinks";
import {
  buildRegisterShredSubjectSql,
  generateShredKey,
} from "./crypto-shred-registry";
import { requireSink } from "./fail-closed";
import { protectedProcedure, router } from "./index";
import { isSoftDeleteSql, type StatusUpdateSql } from "./user-admin";

// The dangerous action this request binds to (a fresh, single-use, (session,
// action)-bound step-up grant for exactly this action).
export const USER_ERASURE_ACTION = "user.erasure" satisfies DangerousAction;

// The erasure audit actions — the `user.<verb>` vocabulary the append-only audit
// schema accepts. The REQUEST is written BEFORE the soft-delete/registry writes and
// the COMPLETION after, so a mid-sequence write failure can never leave a soft-delete
// that was never audited (request-then-completion, mirroring the data-export surface).
export const USER_ERASURE_AUDIT_ACTION = "user.erasure_requested";
export const USER_ERASURE_COMPLETED_AUDIT_ACTION = "user.erasure_completed";

// A record-id key charset conservative enough to bind into a type::record target,
// mirroring the user-admin builders.
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// Build the erasure SOFT-delete: flip status to 'deactivated' and stamp both
// tombstones (deletedAt / erasureRequestedAt). It is an UPDATE (the row survives, so
// erasure is recoverable), NEVER a hard DELETE/REMOVE. The status is a closed-set
// enum literal (safe to inline); the user id + the ISO instant travel as bound
// $vars, never spliced into the body. It passes `isSoftDeleteSql` exactly as the
// admin deactivate does.
export const buildErasureSoftDeleteSql = (
  userId: string,
  nowIso: string
): StatusUpdateSql => {
  if (!SAFE_ID_RE.test(userId)) {
    throw new Error("user id must be a safe record-id key");
  }
  return {
    query:
      "UPDATE type::record('user', $id) SET status = 'deactivated', deletedAt = type::datetime($now), erasureRequestedAt = type::datetime($now) RETURN AFTER;",
    vars: { id: userId, now: nowIso },
  };
};

// The forwarder-backed erasure sink the host injects. Pure over `forward`, so a fake
// forwarder drives it in the gate tests with no live DB.
export interface ErasureSink {
  // Register the subject in the crypto-shred registry (its own independently-
  // generated class-4 key handle). Additive-only (an UPSERT, never a DELETE).
  readonly registerShredSubject: (userId: string) => Promise<void>;
  // Soft-delete the subject's own account (tombstone UPDATE, never a hard DELETE).
  readonly softDeleteForErasure: (
    userId: string,
    nowIso: string
  ) => Promise<void>;
}

// Build the erasure sink from ONE injected forwarder. The soft-delete flips the
// tombstones; the registry registration draws a fresh independent shred key. Both
// ride the single post-auth forwarder.
export const makeErasureSink = (forward: AdminForward): ErasureSink => ({
  registerShredSubject: async (userId) => {
    const { query, vars } = buildRegisterShredSubjectSql(
      userId,
      generateShredKey()
    );
    await forward(query, vars);
  },
  softDeleteForErasure: async (userId, nowIso) => {
    const { query, vars } = buildErasureSoftDeleteSql(userId, nowIso);
    // Fail closed if a builder ever drifted to a hard delete — the soft-delete law.
    if (!isSoftDeleteSql(query)) {
      throw new Error(
        "erasure must be a soft-delete UPDATE, never a hard delete"
      );
    }
    await forward(query, vars);
  },
});

// The subset of the unified context the erasure request reads. The audit/lockout
// recorders + the step-up store are threaded exactly as the admin step-up gate; the
// erasure sinks are the two new forwarder-backed writes. `revokeSession` is present
// but NEVER called — a cancelled/rejected step-up aborts only the action.
export interface ErasureContext {
  readonly now?: number;
  readonly recordConsequentAudit?: (event: {
    readonly action: string;
    readonly actor: string;
    readonly target?: string;
  }) => Promise<void> | void;
  readonly recordLockoutFailure?: (subject: string) => void;
  readonly recordStepUpAudit?: (event: {
    readonly action: DangerousAction;
    readonly actor: string;
    readonly outcome: "granted" | "challenged" | "rejected";
  }) => Promise<void> | void;
  readonly registerShredSubject?: ErasureSink["registerShredSubject"];
  readonly revokeSession?: (sessionId: string) => void;
  readonly session: {
    readonly id: string;
    readonly user: { readonly id: string; readonly role: string };
  } | null;
  readonly softDeleteForErasure?: ErasureSink["softDeleteForErasure"];
  readonly stepUpStore?: StepUpGrantStore;
  readonly stepUpToken?: string;
}

// Throw the nearest native FORBIDDEN carrying STEP_UP_REQUIRED in shape.data.code.
const stepUpRequired = (): never => {
  throw new TRPCError({
    cause: { code: "STEP_UP_REQUIRED" },
    code: "FORBIDDEN",
    message: "Step-up re-authentication required for this action",
  });
};

// The self-service step-up decision for erasure: audits every attempt, throws
// STEP_UP_REQUIRED on the challenge/rejection, and on a rejection routes through the
// shared lockout seam. It NEVER touches the actor's session. Returns only on a
// granted, freshly-consumed grant for THIS (session, `user.erasure`) — a prior grant
// for another action resolves `cross-action` and never satisfies it. The audit sink
// is resolved fail-closed up front, so erasure can never proceed — or be challenged
// — without its step-up audit wired.
const consumeErasureStepUp = async (ctx: ErasureContext): Promise<void> => {
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
    await recordStepUpAudit({
      action: USER_ERASURE_ACTION,
      actor,
      outcome: "challenged",
    });
    stepUpRequired();
  }
  const store = requireSink(ctx.stepUpStore, "stepUpStore");
  const result = store.verifyAndConsume({
    action: USER_ERASURE_ACTION,
    now: ctx.now ?? Date.now(),
    sessionId: ctx.session.id,
    token: ctx.stepUpToken,
  });
  if (!result.granted) {
    await recordStepUpAudit({
      action: USER_ERASURE_ACTION,
      actor,
      outcome: "rejected",
    });
    ctx.recordLockoutFailure?.(actor);
    stepUpRequired();
  }
  await recordStepUpAudit({
    action: USER_ERASURE_ACTION,
    actor,
    outcome: "granted",
  });
};

export const erasureRouter = router({
  // Self-service GDPR erasure. Any authenticated member may erase their OWN account;
  // the scope is the server-derived subject, so no role gate is applied (a self
  // right, not an admin oversight action). It is step-up-guarded: a fresh, single-use
  // grant bound to (this session, `user.erasure`) is required — a prior grant for a
  // different action never satisfies it — and a cancel/reject aborts ONLY the action.
  // On a granted request the account is SOFT-deleted (tombstones, never a hard
  // DELETE), the subject is registered for the deferred crypto-shred, and the erasure
  // event is written to the immutable audit log. All three writes fail closed on a
  // tier with no forwarder wired.
  requestErasure: protectedProcedure
    .use(async ({ ctx, next }) => {
      await consumeErasureStepUp(ctx);
      return next({ ctx: { ...ctx, session: ctx.session } });
    })
    .mutation(async ({ ctx }) => {
      const userId = ctx.session.user.id;
      // Resolve every fail-closed seam BEFORE any write, so a missing forwarder or a
      // missing audit sink fails the whole request closed — never a partial erasure.
      const recordConsequentAudit = requireSink(
        ctx.recordConsequentAudit,
        "recordConsequentAudit"
      );
      const softDeleteForErasure = requireSink(
        ctx.softDeleteForErasure,
        "softDeleteForErasure"
      );
      const registerShredSubject = requireSink(
        ctx.registerShredSubject,
        "registerShredSubject"
      );
      const nowIso = new Date(ctx.now ?? Date.now()).toISOString();
      // Audit the erasure REQUEST on the immutable log FIRST — before any soft-delete
      // or registry write (actor = target = subject). A mid-sequence write failure can
      // then never leave a soft-deleted account that was never audited.
      await recordConsequentAudit({
        action: USER_ERASURE_AUDIT_ACTION,
        actor: userId,
        target: userId,
      });
      // Soft-delete the caller's OWN account (tombstone UPDATE, never a hard delete).
      await softDeleteForErasure(userId, nowIso);
      // Register the subject for the DEFERRED crypto-shred (class-4 key registry).
      await registerShredSubject(userId);
      // Audit the COMPLETION after the writes land, closing the request→completion pair.
      await recordConsequentAudit({
        action: USER_ERASURE_COMPLETED_AUDIT_ACTION,
        actor: userId,
        target: userId,
      });
      // The erasure is recoverable (soft) and the shred mechanism is DEFERRED — the
      // response never claims actual cryptographic destruction.
      return { erased: true, recoverable: true } as const;
    }),
});

// The dangerous-action map this router wires (the coverage gate probes it to prove
// erasure is step-up-guarded, and asserts no drift from the wired procedure).
export const ERASURE_STEP_UP_PROCEDURES = {
  requestErasure: USER_ERASURE_ACTION,
} as const satisfies Record<string, DangerousAction>;

export const createErasureCaller = (ctx: ErasureContext) =>
  erasureRouter.createCaller(ctx as never);
