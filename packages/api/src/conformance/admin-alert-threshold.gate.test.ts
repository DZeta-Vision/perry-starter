import { DEFAULT_LOCKOUT_THRESHOLDS } from "@perry-starter/auth/lockout-policy";
import { describe, expect, test } from "vitest";

import {
  buildLockoutAlertNotification,
  evaluateLockoutAlert,
  isEnumerationSafeNotification,
  LOCKOUT_ESCALATION_ACTION,
  shouldEmitLockoutAlert,
} from "../admin-alert";
import { auditWriteInputSchema, buildAuditWriteSql } from "../audit-log";

// Conformance gate — the admin-alert on repeated failed logins fires ONCE at the
// escalation boundary and produces an enumeration-safe audit event + notification:
//   (a) it fires exactly when the count first EQUALS the lock threshold, never
//       before and never on every attempt past it;
//   (b) the audit event is a VALID append via the shipped vocabulary + builder;
//   (c) the notification body reveals no registration status and no secret.
//
// The mutation twin (admin-alert-threshold.mutation.test.ts) proves a `>=` variant
// spams on every attempt and an enumeration-leaking / secret-bearing body reddens.

const LOCK_AT = DEFAULT_LOCKOUT_THRESHOLDS.lockAt;
const SUBJECT = { kind: "account", subject: "attacked@example.com" } as const;
const A_VALID_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("the admin-alert fires once at the escalation boundary with an enumeration-safe payload", () => {
  test("it fires exactly at the lock threshold — not before, not on the next attempt", () => {
    expect(shouldEmitLockoutAlert(LOCK_AT - 1)).toBe(false);
    expect(shouldEmitLockoutAlert(LOCK_AT)).toBe(true);
    expect(shouldEmitLockoutAlert(LOCK_AT + 1)).toBe(false);
  });

  test("a boundary cross yields BOTH an audit append and a notification; a non-cross yields neither", () => {
    const below = evaluateLockoutAlert(LOCK_AT - 1, SUBJECT);
    expect(below.fire).toBe(false);

    const decision = evaluateLockoutAlert(LOCK_AT, SUBJECT, undefined, {
      ip: "203.0.113.7",
    });
    expect(decision.fire).toBe(true);
    if (decision.fire) {
      expect(decision.audit.action).toBe(LOCKOUT_ESCALATION_ACTION);
      expect(decision.notification.count).toBe(LOCK_AT);
    }
  });

  test("the audit event is a valid append through the shipped vocabulary + builder", () => {
    const decision = evaluateLockoutAlert(LOCK_AT, SUBJECT);
    expect(decision.fire).toBe(true);
    if (!decision.fire) {
      return;
    }
    // The action stays inside the closed lockout.* vocabulary...
    expect(() => auditWriteInputSchema.parse(decision.audit)).not.toThrow();
    // ...and the shipped builder produces an injection-safe CREATE for it.
    const { query } = buildAuditWriteSql(A_VALID_ULID, decision.audit);
    expect(query).toContain("CREATE type::record('audit_log'");
    expect(query).toContain("action = $action");
  });

  test("the notification is enumeration-safe: no registration language, no secret", () => {
    const decision = evaluateLockoutAlert(LOCK_AT, SUBJECT);
    expect(decision.fire).toBe(true);
    if (!decision.fire) {
      return;
    }
    const { notification } = decision;

    expect(isEnumerationSafeNotification(notification)).toBe(true);
    const text = `${notification.title}\n${notification.body}`.toLowerCase();
    expect(text).not.toContain("registered");
    expect(text).not.toContain("exist");
    // The body reveals no credential either.
    expect(text).not.toContain("password");
  });

  test("the audit carries the subject as the target, the system as the actor, and no secret metadata", () => {
    const decision = evaluateLockoutAlert(LOCK_AT, SUBJECT);
    expect(decision.fire).toBe(true);
    if (!decision.fire) {
      return;
    }
    expect(decision.audit.target_id).toBe(SUBJECT.subject);
    expect(decision.audit.target_type).toBe("account");
    expect(decision.audit.actor).toBe("system");
    // metadata keys are non-secret operational fields only.
    expect(Object.keys(decision.audit.metadata).sort()).toEqual([
      "count",
      "perimeter",
      "threshold",
    ]);
  });

  test("the notification builder is stable across perimeters (positive control on the ip perimeter)", () => {
    const notification = buildLockoutAlertNotification(
      { kind: "ip", subject: "203.0.113.7" },
      LOCK_AT
    );
    expect(notification.perimeter).toBe("ip");
    expect(isEnumerationSafeNotification(notification)).toBe(true);
  });
});
