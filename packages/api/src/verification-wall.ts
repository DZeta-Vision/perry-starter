// The post-auth verification wall.
//
// An authenticated-but-unverified member hitting any protected op is denied with
// EMAIL_NOT_VERIFIED — which is NOT a native TRPCError code, so it rides in
// shape.data.code per the AD-21 envelope (carried on the error cause, like
// SESSION_EXPIRED / ACCOUNT_LOCKED). A verified member passes. The resend
// affordance is rate-limited and phrased NON-numerically (no countdown — a
// countdown would leak rate/timing state and clash with the anti-enum posture).
//
// EMAIL_NOT_VERIFIED is a post-auth state only; it is unreachable on the pre-auth
// surfaces (those return the one neutral envelope).

import { initTRPC, TRPCError } from "@trpc/server";

export const EMAIL_NOT_VERIFIED_CODE = "EMAIL_NOT_VERIFIED";

// Generic, non-numeric resend copy — a keyed message, never "try again in N s".
export const VERIFICATION_RESEND_COPY = "auth.verification.resend.check_inbox";

// The error cause carries the precise AD-21 code. An Error subclass survives tRPC
// caller propagation unchanged (so `rejectionCode` reads it reliably).
class VerificationWallError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "VerificationWallError";
  }
}

interface WallSession {
  readonly emailVerified: boolean;
}
interface WallContext {
  readonly session: WallSession | null;
}

const tWall = initTRPC.context<WallContext>().create();

// Held-on-the-wall procedure: unverified → EMAIL_NOT_VERIFIED (in the cause);
// verified → passes.
const verifiedProcedure = tWall.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }
  if (!ctx.session.emailVerified) {
    throw new TRPCError({
      cause: new VerificationWallError(EMAIL_NOT_VERIFIED_CODE),
      code: "FORBIDDEN",
      message: "Email verification required",
    });
  }
  return next();
});

export const verificationWallRouter = tWall.router({
  protectedOp: verifiedProcedure.query(() => ({ ok: true })),
});

export const createVerificationWallCaller = (ctx: WallContext) =>
  verificationWallRouter.createCaller(ctx);

// Extract the precise AD-21 code from a thrown wall error: the cause's `code` if
// present (EMAIL_NOT_VERIFIED), else the native TRPCError code.
export const rejectionCodeOf = (error: unknown): string | undefined => {
  if (error instanceof TRPCError) {
    const cause = error.cause;
    if (cause && typeof cause === "object" && "code" in cause) {
      return (cause as { code: string }).code;
    }
    return error.code;
  }
  return;
};
