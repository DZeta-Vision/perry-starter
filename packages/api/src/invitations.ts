// The pending-invitation surface: create / resend / revoke / accept.
//
// Invitations are their own records where the account is provisioned ONLY on
// acceptance, so no half-formed privileged account ever exists before acceptance.
// Two-layer authorization, one hierarchy: the create/resend/revoke procedures here
// are the in-process (tRPC) leg — admin-gated + (for the token-issuing ops)
// step-up-guarded + audited; the sealed `invitation` row (`PERMISSIONS NONE`, the
// privileged forwarder writes it) is the second leg.
//
// c4 — who may stamp which role: the create/resend role authority reuses the
// no-escalation numeric hierarchy (an invitation may stamp only a role STRICTLY
// BELOW the inviter's tier), so a plain Administrator invites only a member, admin
// creation is superadmin-only, and a superadmin is never mintable via an invitation.
//
// Anti-enumeration: every surface (create/resend/accept) returns the ONE neutral
// envelope regardless of whether the target email is already an account, so no
// surface reveals existence/state. The privileged role is stamped only at accept.

import {
  acceptInvitation as acceptInvitationRow,
  evaluateInvitationAcceptance,
  evaluateInvitationRole,
  expiresAt,
  mintInvitationToken,
} from "@perry-starter/auth/invitation-lifecycle";
import { holdsAdminSurface } from "@perry-starter/auth/rbac";
import { hashToken } from "@perry-starter/auth/secret-hash";
import type { DangerousAction } from "@perry-starter/auth/step-up";
import type { StepUpGrantStore } from "@perry-starter/auth/step-up-store";
import { type AppRole, appRoleSchema } from "@perry-starter/db/shapes/identity";
import type { Invitation } from "@perry-starter/db/shapes/invitation";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  type InvitationOutcome,
  invitationSurfaceResponse,
  type SurfaceResponse,
} from "./invitation-surface";

// --- The context-injected seams ----------------------------------------------

// The row the privileged forwarder writes for a fresh invitation (the record id +
// created_at/status defaults are assigned by the store).
export interface PersistInvitationInput {
  readonly email: string;
  readonly expiresAt: string;
  readonly invitedBy: string;
  readonly organizationId: string | null;
  readonly role: AppRole;
  readonly tokenHash: string;
}

interface InvitationSession {
  readonly id: string;
  readonly user: { readonly id: string; readonly role: string };
}

export interface InvitationContext {
  // Load an invitation by its token digest (the single-use acceptance lookup key).
  readonly loadInvitationByTokenHash: (
    tokenHash: string
  ) => Promise<Invitation | null> | Invitation | null;
  // Mark an invitation accepted (single-use: stamps accepted_at so a replay resolves
  // to consumed).
  readonly markInvitationAccepted: (input: {
    readonly tokenHash: string;
    readonly acceptedAt: string;
  }) => Promise<void> | void;
  // Injected clock so the TTL/expiry boundary is driven deterministically.
  readonly now: number;
  // Persist a fresh pending invitation (invitation row ONLY — never a user row).
  readonly persistInvitation: (
    input: PersistInvitationInput
  ) => Promise<void> | void;
  // Provision the invited account — role-stamped + emailVerified — called ONLY on a
  // valid acceptance (mandatory 2FA for admin/superadmin is enforced by the existing
  // credential chain on their next operation).
  readonly provisionInvitedAccount: (input: {
    readonly email: string;
    readonly role: AppRole;
    readonly organizationId: string | null;
  }) => Promise<{ readonly userId: string }> | { readonly userId: string };
  readonly recordConsequentAudit: (event: {
    readonly actor: string;
    readonly action: string;
    readonly target: string;
  }) => void;
  // A failed step-up routes through the SAME shared per-subject lockout seam as a
  // failed login (one counter).
  readonly recordLockoutFailure: (subject: string) => void;
  // Audit is outermost: every step-up attempt records actor/action/outcome, and a
  // granted mutation ALSO audits its consequent action.
  readonly recordStepUpAudit: (event: {
    readonly action: DangerousAction;
    readonly actor: string;
    readonly outcome: "granted" | "challenged" | "rejected";
  }) => void;
  // Invalidate any prior invitation for this (email, org) — resend and revoke both
  // use this so an old token can never accept once a new one is issued or the invite
  // is revoked.
  readonly revokePriorInvitations: (input: {
    readonly email: string;
    readonly organizationId: string | null;
  }) => Promise<void> | void;
  // The ACTOR session-revoke seam a step-up FAILURE must NEVER call (cancel /
  // fail-twice aborts only the action, never the session).
  readonly revokeSession: (sessionId: string) => void;
  // The worker-tier email seam — the ONLY delivery of the plaintext token.
  readonly sendInvitationEmail: (input: {
    readonly to: string;
    readonly token: string;
    readonly locale?: string;
  }) => Promise<void> | void;
  readonly session: InvitationSession | null;
  // The server-side single-use step-up grant store + the context-threaded token
  // (middleware runs BEFORE `.input()`).
  readonly stepUpStore: StepUpGrantStore;
  readonly stepUpToken?: string;
}

const codeForError = (error: unknown): string | undefined => {
  if (error instanceof TRPCError) {
    const cause = error.cause as { code?: string } | undefined;
    return cause?.code ?? error.code;
  }
  return;
};

const tInvitation = initTRPC.context<InvitationContext>().create({
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: { ...shape.data, code: codeForError(error) ?? shape.data.code },
  }),
});

const GENERIC_FORBIDDEN = "Insufficient role for this scope";

// Throw the nearest native FORBIDDEN carrying STEP_UP_REQUIRED in shape.data.code.
const stepUpRequired = (): never => {
  throw new TRPCError({
    cause: { code: "STEP_UP_REQUIRED" },
    code: "FORBIDDEN",
    message: "Step-up re-authentication required for this action",
  });
};

// The step-up decision, shared by the token-issuing mutations. Audits every attempt
// and throws STEP_UP_REQUIRED on the challenge/rejection; on a rejection it also
// routes through the shared lockout seam. It NEVER touches the actor's session.
const consumeStepUp = (
  ctx: InvitationContext,
  action: DangerousAction
): void => {
  if (!ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }
  const actor = ctx.session.user.id;
  if (ctx.stepUpToken === undefined) {
    ctx.recordStepUpAudit({ action, actor, outcome: "challenged" });
    stepUpRequired();
  }
  const result = ctx.stepUpStore.verifyAndConsume({
    action,
    now: ctx.now,
    sessionId: ctx.session.id,
    token: ctx.stepUpToken,
  });
  if (!result.granted) {
    ctx.recordStepUpAudit({ action, actor, outcome: "rejected" });
    ctx.recordLockoutFailure(actor);
    stepUpRequired();
  }
  ctx.recordStepUpAudit({ action, actor, outcome: "granted" });
};

// Session-only base: narrows the session non-null for downstream legs.
const sessionProcedure = tInvitation.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});

// Admin-surface gate: admin/superadmin only, keyed on the GLOBAL role claim. A
// below-admin session is denied FORBIDDEN with the generic neutral message (no role
// enumeration) — and never reaches the step-up challenge.
const adminProcedure = sessionProcedure.use(({ ctx, next }) => {
  if (!holdsAdminSurface(ctx.session.user.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: GENERIC_FORBIDDEN });
  }
  return next();
});

// The create/resend input. `role` is the role to STAMP on acceptance; the authority
// check (no-escalation) runs in the resolver. `organizationId` is optional so an
// org-membership invitation reuses the same surface.
const issueInput = z.object({
  email: z.email(),
  role: appRoleSchema,
  organizationId: z.string().min(1).optional(),
  locale: z.string().min(1).optional(),
});

const revokeInput = z.object({
  email: z.email(),
  organizationId: z.string().min(1).optional(),
});

const acceptInput = z.object({ token: z.string().min(1) });

// The dangerous-action map this router wires (the coverage gate probes each to prove
// it is step-up-guarded). Both token-issuing ops land the `invite.create` action.
export const INVITATION_STEP_UP_PROCEDURES = {
  createInvitation: "invite.create",
  resendInvitation: "invite.create",
} as const satisfies Record<string, DangerousAction>;

// Reject a non-ok invitation-role verdict. An invalid role is a BAD_REQUEST; every
// authority denial is a FORBIDDEN carrying INVITATION_ROLE_FORBIDDEN — never
// naming the role hierarchy (no enumeration).
const rejectRoleVerdict = (
  verdict: Exclude<ReturnType<typeof evaluateInvitationRole>, "ok">
): never => {
  throw new TRPCError({
    cause: { code: "INVITATION_ROLE_FORBIDDEN" },
    code: verdict === "invalid-role" ? "BAD_REQUEST" : "FORBIDDEN",
    message: GENERIC_FORBIDDEN,
  });
};

// Mint + persist a fresh invitation and dispatch its email. Shared by create and
// resend. Returns the internal outcome (never encoded into the response).
const issueInvitation = async (
  ctx: InvitationContext,
  input: z.infer<typeof issueInput>,
  outcome: InvitationOutcome
): Promise<InvitationOutcome> => {
  if (!ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }
  const verdict = evaluateInvitationRole({
    inviterRole: ctx.session.user.role,
    requestedRole: input.role,
  });
  if (verdict !== "ok") {
    rejectRoleVerdict(verdict);
  }
  const organizationId = input.organizationId ?? null;
  const token = mintInvitationToken();
  const tokenHash = await hashToken(token);
  await ctx.persistInvitation({
    email: input.email,
    expiresAt: new Date(expiresAt(ctx.now)).toISOString(),
    invitedBy: ctx.session.user.id,
    organizationId,
    role: input.role,
    tokenHash,
  });
  await ctx.sendInvitationEmail({
    locale: input.locale,
    to: input.email,
    token,
  });
  return outcome;
};

export const invitationRouter = tInvitation.router({
  // Create a pending invitation: admin-gated + step-up-guarded + audited. The
  // resolver mints a single-use token, persists the invitation row ONLY (never a
  // user row — no half-formed privileged account), emails the token, and audits
  // `admin.invitation_created`. The response is the ONE neutral envelope regardless
  // of whether the email is already an account (enumeration-silent).
  createInvitation: adminProcedure
    .use(({ ctx, next }) => {
      consumeStepUp(ctx, "invite.create");
      return next({ ctx: { ...ctx, session: ctx.session } });
    })
    .input(issueInput)
    .mutation(async ({ ctx, input }): Promise<SurfaceResponse> => {
      const outcome = await issueInvitation(ctx, input, "created");
      ctx.recordConsequentAudit({
        action: "admin.invitation_created",
        actor: ctx.session.user.id,
        target: input.email,
      });
      return invitationSurfaceResponse(outcome);
    }),

  // Resend: admin-gated + step-up-guarded + audited. Invalidates any prior
  // invitation for this (email, org), then issues a NEW token — so the old token can
  // never accept once a new one is issued. Enumeration-silent.
  resendInvitation: adminProcedure
    .use(({ ctx, next }) => {
      consumeStepUp(ctx, "invite.create");
      return next({ ctx: { ...ctx, session: ctx.session } });
    })
    .input(issueInput)
    .mutation(async ({ ctx, input }): Promise<SurfaceResponse> => {
      await ctx.revokePriorInvitations({
        email: input.email,
        organizationId: input.organizationId ?? null,
      });
      const outcome = await issueInvitation(ctx, input, "resent");
      ctx.recordConsequentAudit({
        action: "admin.invitation_resent",
        actor: ctx.session.user.id,
        target: input.email,
      });
      return invitationSurfaceResponse(outcome);
    }),

  // Revoke: admin-gated + audited. Invalidates the invitation's token (a later
  // accept resolves to revoked → fail-closed). Enumeration-silent.
  revokeInvitation: adminProcedure
    .input(revokeInput)
    .mutation(async ({ ctx, input }): Promise<SurfaceResponse> => {
      await ctx.revokePriorInvitations({
        email: input.email,
        organizationId: input.organizationId ?? null,
      });
      ctx.recordConsequentAudit({
        action: "admin.invitation_revoked",
        actor: ctx.session.user.id,
        target: input.email,
      });
      return invitationSurfaceResponse("rejected");
    }),

  // Accept: PUBLIC (the invitee is not yet authenticated) + token-verified. The
  // account is provisioned ONLY on the `ok` verdict — role-stamped + emailVerified —
  // and the invitation is marked accepted (single-use). A revoked/expired/consumed
  // token fails closed (no provision). The response is the ONE neutral envelope
  // regardless of the verdict, so acceptance is enumeration-silent and reveals
  // nothing about the token or the email.
  acceptInvitation: tInvitation.procedure
    .input(acceptInput)
    .mutation(async ({ ctx, input }): Promise<SurfaceResponse> => {
      const tokenHash = await hashToken(input.token);
      const invitation = await ctx.loadInvitationByTokenHash(tokenHash);
      const verdict = evaluateInvitationAcceptance({
        invitation,
        now: ctx.now,
        tokenMatches:
          invitation !== null && invitation.token_hash === tokenHash,
      });
      if (verdict === "ok" && invitation) {
        await ctx.provisionInvitedAccount({
          email: invitation.email,
          organizationId: invitation.organization_id,
          role: invitation.role,
        });
        const accepted = acceptInvitationRow(invitation, ctx.now);
        await ctx.markInvitationAccepted({
          acceptedAt: accepted.accepted_at ?? new Date(ctx.now).toISOString(),
          tokenHash,
        });
        ctx.recordConsequentAudit({
          action: "admin.invitation_accepted",
          actor: invitation.email,
          target: invitation.email,
        });
      }
      return invitationSurfaceResponse("accepted");
    }),
});

export const createInvitationCaller = (ctx: InvitationContext) =>
  invitationRouter.createCaller(ctx);

// Introspect the router's exposed procedures so a conformance test can assert the
// surface shape (no public admin-signup route: only `acceptInvitation` is
// sessionless, and it stamps only the role its authority-checked invitation carries).
export const invitationRouterProcedures = (): ReadonlyArray<{
  readonly name: string;
  readonly type: string;
}> => {
  const procedures = (
    invitationRouter as unknown as {
      _def: { procedures: Record<string, { _def: { type: string } }> };
    }
  )._def.procedures;
  return Object.entries(procedures).map(([name, procedure]) => ({
    name,
    type: procedure._def.type,
  }));
};
