// Acceptance — the shared per-subject lockout-recording seam.
//
// A failed step-up must route to the SAME per-subject counter as a failed login —
// one counter, not two. The load-bearing property is that the counter key is derived
// from the SUBJECT alone (reason-independent): a failed login and a failed step-up
// for the same subject collapse onto the same key. The strongly-consistent
// Durable-Object counter behind the seam and the account-locked escalation it drives
// are a LATER tier's concern and are NOT built here — this module is only the
// recording boundary, so the default recorder is a safe no-op.

import {
  configureLockoutRecorder,
  type LockoutFailure,
  lockoutCounterKey,
  recordLockoutFailure,
  recordLoginFailure,
  recordStepUpFailure,
  resetLockoutRecorder,
} from "@perry-starter/auth/lockout-seam";
import { afterEach, describe, expect, test } from "vitest";

afterEach(() => resetLockoutRecorder());

describe("a failed step-up records through the same per-subject seam as a failed login", () => {
  test("a failed login and a failed step-up for the same subject route to the SAME counter key", () => {
    const captured: LockoutFailure[] = [];
    configureLockoutRecorder((failure) => captured.push(failure));

    recordLoginFailure("user-1");
    recordStepUpFailure("user-1");

    expect(captured).toHaveLength(2);
    expect(captured[0].reason).toBe("login");
    expect(captured[1].reason).toBe("step_up");
    // The counter key is subject-derived and reason-INDEPENDENT — so both failures
    // increment the ONE counter, never a separate one.
    expect(lockoutCounterKey(captured[0])).toBe(lockoutCounterKey(captured[1]));
    expect(lockoutCounterKey(captured[0])).toBe("account:user-1");
  });

  test("different subjects route to different counters (the key discriminates by subject)", () => {
    const captured: LockoutFailure[] = [];
    configureLockoutRecorder((failure) => captured.push(failure));

    recordStepUpFailure("user-1");
    recordStepUpFailure("user-2");

    expect(lockoutCounterKey(captured[0])).not.toBe(
      lockoutCounterKey(captured[1])
    );
  });

  test("the default recorder is a safe no-op — no wiring never throws (the DO counter is deferred)", () => {
    // With no recorder configured, recording is a silent no-op: the DO-backed
    // increment + account-locked escalation are a later tier, not built here.
    expect(() => recordStepUpFailure("user-1")).not.toThrow();
    expect(() => recordLoginFailure("user-1")).not.toThrow();
  });

  test("recordLockoutFailure carries the raw failure (kind, subject, reason) to the recorder", () => {
    const captured: LockoutFailure[] = [];
    configureLockoutRecorder((failure) => captured.push(failure));
    recordLockoutFailure({
      kind: "ip",
      reason: "login",
      subject: "203.0.113.7",
    });
    expect(captured[0]).toEqual({
      kind: "ip",
      reason: "login",
      subject: "203.0.113.7",
    });
    expect(lockoutCounterKey(captured[0])).toBe("ip:203.0.113.7");
  });
});
