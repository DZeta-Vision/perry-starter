import { DEFAULT_LOCKOUT_THRESHOLDS } from "@perry-starter/auth/lockout-policy";
import { describe, expect, test } from "vitest";

import {
  type AdminAlertNotification,
  evaluateLockoutAlert,
  isEnumerationSafeNotification,
  shouldEmitLockoutAlert,
} from "../admin-alert";

// Mutation twin for admin-alert-threshold.gate.test.ts. It plants the two failure
// modes the gate must catch and proves each reddens, with clean controls:
//   (1) a `>=` (fires-on-every-attempt) variant spams past the boundary;
//   (2) an enumeration-leaking body / a secret-bearing field defeats the safety
//       guard.

const LOCK_AT = DEFAULT_LOCKOUT_THRESHOLDS.lockAt;
const SUBJECT = { kind: "account", subject: "attacked@example.com" } as const;

// The BUGGY "fires on every attempt past the boundary" predicate.
const firesEveryAttempt = (count: number): boolean => count >= LOCK_AT;

describe("a fires-on-every-attempt variant spams the admin past the boundary", () => {
  test("the `>=` variant fires on the boundary AND every attempt after it → reddens the fire-once expectation", () => {
    expect(firesEveryAttempt(LOCK_AT)).toBe(true);
    expect(firesEveryAttempt(LOCK_AT + 1)).toBe(true);
    expect(firesEveryAttempt(LOCK_AT + 5)).toBe(true);
  });

  test("the CORRECT fire-once predicate fires only at the boundary (control)", () => {
    expect(shouldEmitLockoutAlert(LOCK_AT)).toBe(true);
    expect(shouldEmitLockoutAlert(LOCK_AT + 1)).toBe(false);
    expect(shouldEmitLockoutAlert(LOCK_AT + 5)).toBe(false);
  });
});

describe("an enumeration-leaking or secret-bearing body defeats the safety guard", () => {
  const safeNotification = (): AdminAlertNotification => {
    const decision = evaluateLockoutAlert(LOCK_AT, SUBJECT);
    if (!decision.fire) {
      throw new Error("expected a boundary cross");
    }
    return decision.notification;
  };

  test("a body that names registration status is NOT enumeration-safe → reddens", () => {
    const leaky: AdminAlertNotification = {
      ...safeNotification(),
      body: "The registered account attacked@example.com was locked out.",
    };
    expect(isEnumerationSafeNotification(leaky)).toBe(false);
  });

  test("a notification carrying a secret-bearing field is NOT safe → reddens", () => {
    const withSecret = {
      ...safeNotification(),
      token: "leak-me-tok",
    } as unknown as AdminAlertNotification;
    expect(isEnumerationSafeNotification(withSecret)).toBe(false);
  });

  test("the correct neutral notification IS enumeration-safe (not always-red control)", () => {
    expect(isEnumerationSafeNotification(safeNotification())).toBe(true);
  });
});
