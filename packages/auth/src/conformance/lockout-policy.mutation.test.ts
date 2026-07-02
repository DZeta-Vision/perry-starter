// Mutation twin for lockout-policy.gate.test.ts.
//
// It proves the gate's shape checks are anti-vacuous. The gate trusts two
// properties: (1) the tier ranking never regresses as the count rises, and (2)
// Retry-After is non-zero ONLY at the locked tier. This twin builds DELIBERATELY
// BROKEN policies that violate each and asserts the SAME shape checks redden —
// while the REAL policy stays green.

import {
  DEFAULT_LOCKOUT_THRESHOLDS,
  evaluateLockoutTier,
  type LockoutDecision,
  type LockoutTier,
} from "@perry-starter/auth/lockout-policy";
import { describe, expect, test } from "vitest";

const RANK: Record<LockoutTier, number> = {
  captcha: 2,
  friction: 1,
  locked: 3,
  none: 0,
};

const T = DEFAULT_LOCKOUT_THRESHOLDS;

// A NON-monotonic policy: it de-escalates back to `none` past the lock threshold
// (modeling a regression that lets a high count relax friction).
const nonMonotonicTier = (count: number): LockoutDecision =>
  count >= T.lockAt
    ? { retryAfterSeconds: 0, tier: "none" }
    : evaluateLockoutTier(count);

// A Retry-After-leaking policy: it reports a non-zero countdown at the CAPTCHA
// tier (modeling a leak of the timed-lock window into a softer tier).
const leakyRetryAfter = (count: number): LockoutDecision => {
  const decision = evaluateLockoutTier(count);
  return decision.tier === "captcha"
    ? { retryAfterSeconds: 42, tier: "captcha" }
    : decision;
};

describe("the monotonic-escalation check reddens on a de-escalating policy", () => {
  test("a non-monotonic policy trips the never-regress assertion", () => {
    let regressed = false;
    let previous = -1;
    for (let count = 0; count <= T.lockAt + 5; count++) {
      const rank = RANK[nonMonotonicTier(count).tier];
      if (rank < previous) {
        regressed = true;
      }
      previous = rank;
    }
    expect(regressed).toBe(true);
  });

  test("the REAL policy never regresses under the same scan", () => {
    let regressed = false;
    let previous = -1;
    for (let count = 0; count <= T.lockAt + 5; count++) {
      const rank = RANK[evaluateLockoutTier(count).tier];
      if (rank < previous) {
        regressed = true;
      }
      previous = rank;
    }
    expect(regressed).toBe(false);
  });
});

describe("the retryAfter-only-when-locked check reddens on a leaking policy", () => {
  test("a leaky policy exposes a non-zero Retry-After at a softer (captcha) tier", () => {
    const decision = leakyRetryAfter(T.captchaAt);
    expect(decision.tier).not.toBe("locked");
    expect(decision.retryAfterSeconds).not.toBe(0);
  });

  test("the REAL policy keeps Retry-After at zero for every softer tier", () => {
    for (const count of [0, T.frictionAt, T.captchaAt]) {
      const decision = evaluateLockoutTier(count);
      expect(decision.tier).not.toBe("locked");
      expect(decision.retryAfterSeconds).toBe(0);
    }
  });
});
