// Email-verification token lifecycle: a time-limited (TTL 1h), single-use token.
//
// A valid, unexpired, unconsumed token verifies the account and clears the wall;
// an EXPIRED or ALREADY-CONSUMED (or unknown) token is rejected with the SAME
// neutral copy, so no account state is ever revealed (an "expired"/"already used"
// distinction would itself be probable). The neutral copy is sourced from the ONE
// canonical db envelope so the rejection cannot drift from the pre-auth surfaces.

import { neutralAuthEnvelope } from "@perry-starter/db/auth/neutral-response";

// Epic-2 tunable: email-verification token TTL is 1 hour. Single-sourced so the
// better-auth `emailVerification.expiresIn` reads exactly this value.
export const VERIFICATION_TOKEN_TTL_SECONDS = 3600;

// The single neutral rejection copy — byte-identical for expired / consumed /
// unknown. Sourced from the one db envelope body so it cannot diverge.
export const NEUTRAL_VERIFICATION_REJECTION_COPY =
  neutralAuthEnvelope.body.message;

export interface VerificationTokenRecord {
  consumed: boolean;
  readonly expiresAtMs: number;
  readonly token: string;
  readonly userId: string;
}

export interface ConsumeResult {
  readonly ok: boolean;
  readonly userId?: string;
}

// Consume a verification token. Single-use + TTL-bounded: returns `ok: false` for
// an unknown, expired, or already-consumed token (the caller maps all three to the
// same neutral copy). A successful consume marks the record consumed so a second
// attempt cannot succeed.
export const consumeVerificationToken = (
  records: Map<string, VerificationTokenRecord>,
  token: string,
  nowMs: number
): ConsumeResult => {
  const record = records.get(token);
  if (!record || record.consumed || record.expiresAtMs <= nowMs) {
    return { ok: false };
  }
  record.consumed = true;
  return { ok: true, userId: record.userId };
};
