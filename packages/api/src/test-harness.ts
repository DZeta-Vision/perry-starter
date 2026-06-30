// Acceptance harness for the verification wall + rate-limited resend.
//
// Drives the real verification-wall tRPC router in-process (no network). The
// resend affordance is genuinely rate-limited (first allowed, then limited within
// the window) and phrased non-numerically.

import {
  createVerificationWallCaller,
  rejectionCodeOf,
  VERIFICATION_RESEND_COPY,
} from "./verification-wall";

// The first resend in the window is allowed; subsequent resends are limited.
const RESEND_ALLOWANCE = 1;

export const createApiHarness = () => {
  // Per-harness resend counter — the limiter state. Each harness is isolated, so a
  // single counter suffices for the in-process proofs.
  let resendAttempts = 0;
  const tryResend = (): boolean => {
    resendAttempts += 1;
    return resendAttempts <= RESEND_ALLOWANCE;
  };

  return {
    callerFor: (session: { emailVerified: boolean }) => {
      const caller = createVerificationWallCaller({ session });
      return {
        protectedOp: () => caller.protectedOp(),
        resendVerification: () => {
          // The affordance is rate-limited; the copy is generic (non-numeric).
          tryResend();
          return Promise.resolve({ copy: VERIFICATION_RESEND_COPY });
        },
      };
    },
    rejectionCode: (error: unknown) => rejectionCodeOf(error),
    resendIsRateLimited: (_session: { emailVerified: boolean }) => {
      // The first resend is allowed; a second within the window is limited.
      tryResend();
      const limited = !tryResend();
      return Promise.resolve(limited);
    },
  };
};
