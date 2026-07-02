// The per-action step-up re-auth grant — a PURE, target-agnostic policy over an
// injected clock reading and a server-minted grant record.
//
// A dangerous mutation (role change, invitation creation, and the reserved future
// ban/impersonate set) must not proceed on a stale or replayed re-auth. This module
// is the single source of the step-up SECURITY PROPERTIES: a grant is fresh,
// single-use, short-TTL, server-verified, and bound to (session, action). It reads
// no wall clock and holds no state (the server-side store owns consumption), so the
// same policy is shareable across tiers and the conformance tests can drive every
// boundary deterministically.
//
// HONESTY GATE: this is NOT `session.freshAge`. better-auth's `freshAge` is a
// coarse, time-based session-freshness backstop measured from `createdAt`; it is
// explicitly NOT the action-bound, single-use, server-verified step-up demanded
// here. None of this is a built-in better-auth feature — it is custom adopter
// wiring, and `freshAge` is never reused as the step-up gate.

// The closed vocabulary of actions that require a step-up grant. `role.change`,
// `invite.create`, `user.ban`, and `user.erasure` are the mutations wired now;
// `user.impersonate` is the reserved future set (declared so the coverage gate
// knows it, guarded when its procedure lands). `user.erasure` gates the GDPR
// self-service erasure request — a member erasing their OWN account must clear a
// fresh, single-use, (session, action)-bound step-up before the soft-delete
// proceeds. Top-level literal — never rebuilt in a loop.
export const DANGEROUS_ACTIONS = [
  "role.change",
  "invite.create",
  "user.ban",
  "user.erasure",
  "user.impersonate",
] as const;

export type DangerousAction = (typeof DANGEROUS_ACTIONS)[number];

const DANGEROUS_ACTION_SET: ReadonlySet<string> = new Set(DANGEROUS_ACTIONS);

export const isDangerousAction = (value: string): value is DangerousAction =>
  DANGEROUS_ACTION_SET.has(value);

// The short-TTL window: a grant is valid for 5 minutes from minting. Single-use and
// (session, action)-bound regardless of the number; the properties are asserted
// independent of this literal, so a later artifact override is a constant swap.
export const STEP_UP_TTL_MS = 5 * 60 * 1000; // 5 min

// The fail-twice ceiling: a second failed step-up for the same (session, action)
// aborts the ACTION (never the session).
export const STEP_UP_MAX_ATTEMPTS = 2;

// A minted grant. `id` is the opaque, unpredictable token the client presents; it
// is meaningless without the server-side store, so a client cannot fabricate one.
// `consumedAt` is the single-use anchor: undefined until spent.
export interface StepUpGrant {
  readonly action: DangerousAction;
  readonly consumedAt: number | undefined;
  readonly expiresAt: number;
  readonly id: string;
  readonly issuedAt: number;
  readonly sessionId: string;
}

// Mint a fresh grant bound to exactly one (session, action). The id is an
// unpredictable UUID (a fresh credential the client cannot guess), and the TTL is
// computed purely from the injected `now` — never a device clock.
export const mintStepUpGrant = ({
  sessionId,
  action,
  now,
}: {
  readonly sessionId: string;
  readonly action: DangerousAction;
  readonly now: number;
}): StepUpGrant => ({
  id: crypto.randomUUID(),
  sessionId,
  action,
  issuedAt: now,
  expiresAt: now + STEP_UP_TTL_MS,
  consumedAt: undefined,
});

// The verification verdict. Every non-`ok` verdict is a rejection that MUST
// re-challenge (never let a mutation through). `missing` covers a token the store
// never minted — the reason a client cannot satisfy step-up by asserting success.
export type StepUpVerdict =
  | "ok"
  | "expired"
  | "cross-action"
  | "cross-session"
  | "consumed"
  | "missing";

// The pure verification decision. It binds to BOTH the session and the action, is
// single-use (a consumed grant is rejected), and enforces the TTL from the injected
// clock. Order is deliberate: a missing grant is rejected before any field read.
export const verifyStepUpGrant = ({
  grant,
  sessionId,
  action,
  now,
}: {
  readonly grant: StepUpGrant | undefined;
  readonly sessionId: string;
  readonly action: DangerousAction;
  readonly now: number;
}): StepUpVerdict => {
  if (!grant) {
    return "missing";
  }
  if (grant.consumedAt !== undefined) {
    return "consumed";
  }
  if (grant.sessionId !== sessionId) {
    return "cross-session";
  }
  if (grant.action !== action) {
    return "cross-action";
  }
  if (now >= grant.expiresAt) {
    return "expired";
  }
  return "ok";
};

// The fail-twice decision: a second failure for the same (session, action) aborts
// the action; a first failure re-challenges. Never a session-scoped verdict — the
// session is never touched by a step-up failure.
export type StepUpFailureVerdict = "re-challenge" | "abort-action";

export const evaluateStepUpFailure = ({
  failureCount,
}: {
  readonly failureCount: number;
}): StepUpFailureVerdict =>
  failureCount >= STEP_UP_MAX_ATTEMPTS ? "abort-action" : "re-challenge";
