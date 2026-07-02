// Mutation twin for lockout-lift.gate.test.ts.
//
// The gate's load-bearing claim is that a timed lock LIFTS at/after its window
// (`reset: true`, tier `none`). The exact bug this replaces is a lock that NEVER
// lifts — a counter with no decay whose `reset()` is never reached, so once locked it
// returns `locked` FOREVER while the Retry-After header lies that it will lift. This
// twin reproduces that permanent-lock variant and asserts the gate's lift assertion
// reddens on it, while the REAL `resolveLockoutState` genuinely lifts.

import {
  DEFAULT_LOCKOUT_THRESHOLDS,
  type LockoutCounterState,
  type LockoutThresholds,
  type ResolvedLockoutState,
  resolveLockoutState,
} from "@perry-starter/auth/lockout-policy";
import { describe, expect, test } from "vitest";

const T = DEFAULT_LOCKOUT_THRESHOLDS;
const LOCK_MS = T.lockDurationSeconds * 1000;

// The PERMANENT-lock bug: once a window is stamped it reports `locked` forever,
// ignoring `nowMs` entirely and never signalling `reset` — the no-decay counter.
const neverLifts = (
  state: LockoutCounterState,
  nowMs: number,
  thresholds: LockoutThresholds
): ResolvedLockoutState =>
  state.lockedUntilMs > 0
    ? {
        reset: false,
        retryAfterSeconds: thresholds.lockDurationSeconds,
        tier: "locked",
      }
    : resolveLockoutState(state, nowMs, thresholds);

describe("the timed-lift check reddens on a never-lifting (permanent-lock) resolver", () => {
  test("the buggy resolver stays locked at/after the window and never resets", () => {
    const lockedUntilMs = 10_000;
    const buggy = neverLifts(
      { count: T.lockAt, lockedUntilMs },
      lockedUntilMs + LOCK_MS,
      T
    );
    // The gate expects tier "none" + reset true here; the permanent-lock bug does the
    // opposite, so the gate's lift assertion would FAIL on it.
    expect(buggy.tier).toBe("locked");
    expect(buggy.reset).toBe(false);
  });

  test("the REAL resolver lifts at/after the window (tier none, reset true)", () => {
    const lockedUntilMs = 10_000;
    const real = resolveLockoutState(
      { count: T.lockAt, lockedUntilMs },
      lockedUntilMs,
      T
    );
    expect(real.tier).toBe("none");
    expect(real.reset).toBe(true);
  });
});
