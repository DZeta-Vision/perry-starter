// Conformance gate — a timed lock genuinely LIFTS after its window and can never
// become a permanent lock.
//
// The pure `resolveLockoutState({ count, lockedUntilMs }, nowMs, thresholds)` is the
// timed-lift core the shipped Durable Object glues `Date.now()` + storage onto. This
// gate asserts the SHAPE of that lift:
//   - AT or AFTER the lock window (`nowMs >= lockedUntilMs`) the lock LIFTS: tier
//     `none`, Retry-After 0, and `reset: true` so the counter is cleared (a fresh
//     start — the property that stops a timed lock from being permanent);
//   - BEFORE the window the lock HOLDS: tier `locked`, `reset: false`, and the
//     Retry-After is the REMAINING seconds (ceil) so it trends to zero;
//   - with NO active lock the tier derives from the count alone (the softer ladder).
// It also asserts the strongest tier wins across the two independent perimeters. The
// mutation twin (lockout-lift.mutation.test.ts) drives a NEVER-lifting resolver (the
// permanent-lock bug) and asserts the SAME lift assertion reddens.

import {
  DEFAULT_LOCKOUT_THRESHOLDS,
  nextLockedUntilMs,
  resolveLockoutState,
  strongerLockoutState,
} from "@perry-starter/auth/lockout-policy";
import { describe, expect, test } from "vitest";

const T = DEFAULT_LOCKOUT_THRESHOLDS;
const LOCK_MS = T.lockDurationSeconds * 1000;

describe("a timed lock genuinely LIFTS at/after its window (never permanent)", () => {
  test("exactly at the window the lock lifts: tier none, Retry-After 0, counter cleared", () => {
    const lockedUntilMs = 10_000;
    const resolved = resolveLockoutState(
      { count: T.lockAt, lockedUntilMs },
      lockedUntilMs,
      T
    );
    expect(resolved.tier).toBe("none");
    expect(resolved.reset).toBe(true);
    expect(resolved.retryAfterSeconds).toBe(0);
  });

  test("well after the window the lock is still lifted and reset (never permanent)", () => {
    const lockedUntilMs = 10_000;
    const resolved = resolveLockoutState(
      { count: T.lockAt + 5, lockedUntilMs },
      lockedUntilMs + LOCK_MS,
      T
    );
    expect(resolved.tier).toBe("none");
    expect(resolved.reset).toBe(true);
  });

  test("before the window the lock HOLDS with a shrinking Retry-After and no reset", () => {
    const nowMs = 10_000;
    const lockedUntilMs = nowMs + LOCK_MS;
    const atStart = resolveLockoutState(
      { count: T.lockAt, lockedUntilMs },
      nowMs,
      T
    );
    expect(atStart.tier).toBe("locked");
    expect(atStart.reset).toBe(false);
    expect(atStart.retryAfterSeconds).toBe(T.lockDurationSeconds);

    const halfway = resolveLockoutState(
      { count: T.lockAt, lockedUntilMs },
      nowMs + LOCK_MS / 2,
      T
    );
    expect(halfway.tier).toBe("locked");
    expect(halfway.retryAfterSeconds).toBe(
      Math.ceil(T.lockDurationSeconds / 2)
    );
  });

  test("with no active lock the tier derives from the count alone (no reset, no Retry-After)", () => {
    const cases = [
      [0, "none"],
      [T.frictionAt, "friction"],
      [T.captchaAt, "captcha"],
    ] as const;
    for (const [count, tier] of cases) {
      const resolved = resolveLockoutState({ count, lockedUntilMs: 0 }, 123, T);
      expect(resolved.tier).toBe(tier);
      expect(resolved.reset).toBe(false);
      expect(resolved.retryAfterSeconds).toBe(0);
    }
  });
});

describe("the lock window is stamped exactly once, when the count first reaches lockAt", () => {
  const NOW = 5000;

  test("below lockAt no window is stamped", () => {
    expect(nextLockedUntilMs(T.lockAt - 1, 0, NOW, T)).toBe(0);
  });

  test("reaching lockAt stamps the window at now + lockDuration", () => {
    expect(nextLockedUntilMs(T.lockAt, 0, NOW, T)).toBe(NOW + LOCK_MS);
  });

  test("an already-stamped window is never re-stamped (kept as-is)", () => {
    const existing = 42_000;
    expect(nextLockedUntilMs(T.lockAt + 3, existing, NOW + 1000, T)).toBe(
      existing
    );
  });
});

describe("the strongest tier wins across the two independent perimeters", () => {
  test("a locked perimeter beats a captcha perimeter regardless of argument order", () => {
    const locked = resolveLockoutState(
      { count: T.lockAt, lockedUntilMs: 1000 },
      0,
      T
    );
    const captcha = resolveLockoutState(
      { count: T.captchaAt, lockedUntilMs: 0 },
      0,
      T
    );
    expect(locked.tier).toBe("locked");
    expect(captcha.tier).toBe("captcha");
    expect(strongerLockoutState(locked, captcha).tier).toBe("locked");
    expect(strongerLockoutState(captcha, locked).tier).toBe("locked");
  });
});
