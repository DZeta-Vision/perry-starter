// Conformance gate — the progressive-lockout escalation policy escalates through
// the SHAPE: as the failure count crosses each threshold the tier moves
// monotonically none -> friction -> captcha -> locked, and Retry-After is non-zero
// ONLY at the locked tier. The gate asserts the SHAPE (ordering + boundaries at the
// defaults + retryAfter-only-when-locked), NOT specific integers — the thresholds
// are an operator-owned defaulted tunable. The mutation twin
// (lockout-policy.mutation.test.ts) drives a NON-monotonic / retryAfter-leaking
// policy and asserts the SAME shape checks redden, proving this gate is not vacuous.

import {
  DEFAULT_LOCKOUT_THRESHOLDS,
  evaluateLockoutTier,
  type LockoutTier,
} from "@perry-starter/auth/lockout-policy";
import { describe, expect, test } from "vitest";

// The escalation order the ladder must follow — a strict, monotonic ranking.
const RANK: Record<LockoutTier, number> = {
  captcha: 2,
  friction: 1,
  locked: 3,
  none: 0,
};

const T = DEFAULT_LOCKOUT_THRESHOLDS;

describe("the escalation policy moves monotonically through the tier ladder", () => {
  test("the tier never regresses as the failure count rises (monotonic escalation)", () => {
    let previous = -1;
    for (let count = 0; count <= T.lockAt + 5; count++) {
      const rank = RANK[evaluateLockoutTier(count).tier];
      expect(rank).toBeGreaterThanOrEqual(previous);
      previous = rank;
    }
  });

  test("each threshold boundary flips exactly at the tunable's value (shape, not literals)", () => {
    // Just below friction -> none; at friction -> friction.
    expect(evaluateLockoutTier(T.frictionAt - 1).tier).toBe("none");
    expect(evaluateLockoutTier(T.frictionAt).tier).toBe("friction");
    // Just below captcha -> friction; at captcha -> captcha.
    expect(evaluateLockoutTier(T.captchaAt - 1).tier).toBe("friction");
    expect(evaluateLockoutTier(T.captchaAt).tier).toBe("captcha");
    // Just below lock -> captcha; at lock -> locked.
    expect(evaluateLockoutTier(T.lockAt - 1).tier).toBe("captcha");
    expect(evaluateLockoutTier(T.lockAt).tier).toBe("locked");
  });

  test("the full ladder is exercised: friction, then a CAPTCHA tier, then a timed lock", () => {
    const tiers = new Set(
      Array.from(
        { length: T.lockAt + 3 },
        (_unused, count) => evaluateLockoutTier(count).tier
      )
    );
    expect(tiers).toContain("none");
    expect(tiers).toContain("friction");
    expect(tiers).toContain("captcha");
    expect(tiers).toContain("locked");
  });
});

describe("Retry-After is populated ONLY at the locked tier", () => {
  test("every softer tier reports a zero Retry-After", () => {
    for (const count of [0, T.frictionAt, T.captchaAt]) {
      const decision = evaluateLockoutTier(count);
      expect(decision.tier).not.toBe("locked");
      expect(decision.retryAfterSeconds).toBe(0);
    }
  });

  test("the locked tier carries a positive Retry-After window (429 + Retry-After)", () => {
    const decision = evaluateLockoutTier(T.lockAt);
    expect(decision.tier).toBe("locked");
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    expect(decision.retryAfterSeconds).toBe(T.lockDurationSeconds);
  });
});
