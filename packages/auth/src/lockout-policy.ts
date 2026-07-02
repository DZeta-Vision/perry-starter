// The PURE progressive-lockout escalation policy — a deterministic state machine
// mapping a failure COUNT to an escalation TIER + the Retry-After seconds.
//
// It is the analogue-independent core of the lockout ladder: increasing friction,
// then a CAPTCHA tier, then a timed lock. The real per-account / per-IP counts
// come from the strongly-consistent Durable-Object counters at runtime; this
// module only decides what a given count MEANS. It performs no I/O and reads no
// clock.
//
// The numeric thresholds are OPERATOR-OWNED, defaulted tunables (not a security
// truth): sensible security defaults live here as named constants and are LOGGED
// at boot; a later hardening artifact pins them. Every property is asserted on the
// SHAPE (monotonic none -> friction -> captcha -> locked as the count crosses each
// tier; Retry-After only when locked), NEVER on the literal integers.

export type LockoutTier = "none" | "friction" | "captcha" | "locked";

export interface LockoutThresholds {
  // Attempts at/after which a CAPTCHA challenge gates the next attempt.
  readonly captchaAt: number;
  // Attempts at/after which extra friction begins (the attempt is still allowed).
  readonly frictionAt: number;
  // Attempts at/after which the subject is timed-locked (429 + Retry-After).
  readonly lockAt: number;
  // The timed-lock duration in seconds — surfaced as the Retry-After value.
  readonly lockDurationSeconds: number;
}

// Defaulted tunable (operator-owned). Ordered friction < captcha < lock so the
// escalation is strictly monotonic. Documented in the story as a defaulted
// tunable to be pinned by a later hardening artifact.
export const DEFAULT_LOCKOUT_THRESHOLDS: LockoutThresholds = {
  captchaAt: 5,
  frictionAt: 3,
  lockAt: 10,
  lockDurationSeconds: 900,
};

export interface LockoutDecision {
  // Non-zero ONLY for the locked tier; every softer tier carries 0 (no countdown
  // is ever derived from a softer tier).
  readonly retryAfterSeconds: number;
  readonly tier: LockoutTier;
}

// Guard the ladder is well-formed (friction < captcha < lock, positive lock
// duration). A misconfigured tunable is a boot-time programming error, not a
// runtime branch — surface it loudly rather than silently mis-escalating.
export const assertOrderedThresholds = (
  thresholds: LockoutThresholds
): void => {
  if (
    !(
      thresholds.frictionAt < thresholds.captchaAt &&
      thresholds.captchaAt < thresholds.lockAt
    )
  ) {
    throw new Error(
      "lockout thresholds must be strictly ordered friction < captcha < lock"
    );
  }
  if (thresholds.lockDurationSeconds <= 0) {
    throw new Error(
      "lockout lock duration must be a positive number of seconds"
    );
  }
};

// The pure decision: map a non-negative failure count to its tier. Monotonic — a
// higher count never yields a softer tier. Retry-After is populated ONLY for the
// locked tier; every softer tier reports 0.
export const evaluateLockoutTier = (
  count: number,
  thresholds: LockoutThresholds = DEFAULT_LOCKOUT_THRESHOLDS
): LockoutDecision => {
  if (count >= thresholds.lockAt) {
    return {
      retryAfterSeconds: thresholds.lockDurationSeconds,
      tier: "locked",
    };
  }
  if (count >= thresholds.captchaAt) {
    return { retryAfterSeconds: 0, tier: "captcha" };
  }
  if (count >= thresholds.frictionAt) {
    return { retryAfterSeconds: 0, tier: "friction" };
  }
  return { retryAfterSeconds: 0, tier: "none" };
};

// The boot-time tunable descriptor — the worker logs THIS so the chosen defaults
// are observable in the deploy logs (a defaulted tunable, not a silent constant).
export const describeLockoutTunables = (
  thresholds: LockoutThresholds = DEFAULT_LOCKOUT_THRESHOLDS
): Readonly<Record<string, number>> => ({
  captchaAt: thresholds.captchaAt,
  frictionAt: thresholds.frictionAt,
  lockAt: thresholds.lockAt,
  lockDurationSeconds: thresholds.lockDurationSeconds,
});

// The escalation ranking (softer -> stronger) — used to pick the STRONGEST tier
// across the two independent perimeters (per-account vs per-IP), never to derive a
// count. Kept beside the ladder so it cannot drift from the tier union.
export const LOCKOUT_TIER_RANK: Readonly<Record<LockoutTier, number>> = {
  captcha: 2,
  friction: 1,
  locked: 3,
  none: 0,
};

// A counter's persisted state: the running failure COUNT and, once the count first
// reaches `lockAt`, the wall-clock instant (epoch ms) the timed lock LIFTS. A zero
// `lockedUntilMs` means "no active timed lock" — the counter is still on the softer
// ladder.
export interface LockoutCounterState {
  readonly count: number;
  readonly lockedUntilMs: number;
}

// The resolved state of a counter AT A GIVEN INSTANT. `reset` is the load-bearing
// timed-LIFT signal: when a lock window has fully passed the counter MUST be cleared
// (a fresh start) so a timed lock can never become a permanent one.
export interface ResolvedLockoutState {
  // True ONLY when a previously-locked window has elapsed — the caller MUST clear
  // the counter so the next attempt starts from zero.
  readonly reset: boolean;
  readonly retryAfterSeconds: number;
  readonly tier: LockoutTier;
}

// The PURE timed-lift decision — the untested-DO-glue-free core of "a timed lock
// genuinely lifts". Given a counter's persisted `{ count, lockedUntilMs }` and the
// current wall-clock `nowMs`, it decides the effective tier + Retry-After AND whether
// the counter must be cleared:
//   - an active lock whose window has PASSED (`nowMs >= lockedUntilMs`) -> the lock
//     LIFTS: tier `none`, no Retry-After, and `reset: true` so the counter is wiped
//     (this is what stops a timed lock from being permanent);
//   - an active lock still WITHIN its window -> `locked` with the remaining seconds
//     (ceil) as Retry-After, no reset;
//   - otherwise -> derive the tier from the count via `evaluateLockoutTier`, carrying
//     the lock duration as Retry-After only if that itself yields `locked`.
// It performs no I/O; the clock is injected as `nowMs` so it is fully deterministic.
export const resolveLockoutState = (
  state: LockoutCounterState,
  nowMs: number,
  thresholds: LockoutThresholds = DEFAULT_LOCKOUT_THRESHOLDS
): ResolvedLockoutState => {
  if (state.lockedUntilMs > 0) {
    if (nowMs >= state.lockedUntilMs) {
      // The lock window has fully elapsed — LIFT it and clear the counter so the
      // subject starts fresh (never a permanent lock).
      return { reset: true, retryAfterSeconds: 0, tier: "none" };
    }
    // Still locked — the Retry-After is the REMAINING window, so the header never
    // over-reports and always trends to zero as the window closes.
    return {
      reset: false,
      retryAfterSeconds: Math.ceil((state.lockedUntilMs - nowMs) / 1000),
      tier: "locked",
    };
  }
  const decision = evaluateLockoutTier(state.count, thresholds);
  return {
    reset: false,
    retryAfterSeconds:
      decision.tier === "locked" ? thresholds.lockDurationSeconds : 0,
    tier: decision.tier,
  };
};

// Pick the STRONGER of two resolved states (the per-account vs per-IP perimeters
// escalate independently; the effective gate is the strongest of the two). Ties keep
// the first, so a `locked` account beats a `captcha` IP and vice-versa.
export const strongerLockoutState = (
  a: ResolvedLockoutState,
  b: ResolvedLockoutState
): ResolvedLockoutState =>
  LOCKOUT_TIER_RANK[a.tier] >= LOCKOUT_TIER_RANK[b.tier] ? a : b;

// Decide whether an increment that just landed `count` should STAMP the timed-lock
// window. The stamp happens exactly once — when the count FIRST reaches `lockAt` and
// no window is already active — yielding the lift instant `nowMs + lockDuration`. A
// zero return means "leave the existing window untouched" (already stamped, or not
// yet at the lock threshold).
export const nextLockedUntilMs = (
  count: number,
  currentLockedUntilMs: number,
  nowMs: number,
  thresholds: LockoutThresholds = DEFAULT_LOCKOUT_THRESHOLDS
): number => {
  if (currentLockedUntilMs > 0) {
    return currentLockedUntilMs;
  }
  if (count >= thresholds.lockAt) {
    return nowMs + thresholds.lockDurationSeconds * 1000;
  }
  return 0;
};
