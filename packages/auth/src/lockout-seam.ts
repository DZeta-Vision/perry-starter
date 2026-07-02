// The shared per-subject lockout-recording seam.
//
// A failed LOGIN and a failed STEP-UP both record through THIS one seam, keyed by
// SUBJECT (account / ip), so they route to a SINGLE per-subject counter — never two.
// The counter key is derived from the subject alone (reason-INDEPENDENT), which is
// the load-bearing property: a failed step-up and a failed login for the same
// subject increment the SAME counter.
//
// DEFERRED (later progressive-lockout tier): the strongly-consistent
// Durable-Object counter behind this seam — and the account-locked + CAPTCHA
// escalation it drives — are NOT built here. This module is ONLY the recording
// boundary; the injected recorder is bound to the real DO-backed counter by the
// cloud tier later. The default recorder is a safe no-op so a missing wiring never
// throws and the package stays SDK-free. No numeric lockout thresholds are invented
// here.

export type LockoutSubjectKind = "account" | "ip";

// Why the failure happened. It is carried for the audit/observability trail only —
// it NEVER changes which counter the failure routes to (the key is subject-derived).
export type LockoutFailureReason = "login" | "step_up";

export interface LockoutFailure {
  readonly kind: LockoutSubjectKind;
  readonly reason: LockoutFailureReason;
  readonly subject: string;
}

// The counter key: `${kind}:${subject}` — deliberately independent of `reason`, so
// a failed login and a failed step-up for the same subject collapse onto ONE
// counter. This is the seam's single-counter guarantee.
export const lockoutCounterKey = (
  failure: Pick<LockoutFailure, "kind" | "subject">
): string => `${failure.kind}:${failure.subject}`;

export type LockoutRecorder = (failure: LockoutFailure) => void;

const NOOP_RECORDER: LockoutRecorder = () => undefined;

let recorder: LockoutRecorder = NOOP_RECORDER;

// The cloud tier binds the real DO-backed recorder here at boot; tests inject a spy.
export const configureLockoutRecorder = (next: LockoutRecorder): void => {
  recorder = next;
};

export const resetLockoutRecorder = (): void => {
  recorder = NOOP_RECORDER;
};

// The single recording entry point. Both failed-login and failed-step-up call this
// (via the wrappers below), so every subject failure — whatever its reason — routes
// through the one recorder to the one per-subject counter.
export const recordLockoutFailure = (failure: LockoutFailure): void => {
  recorder(failure);
};

// A failed login records through the shared seam.
export const recordLoginFailure = (
  subject: string,
  kind: LockoutSubjectKind = "account"
): void => recordLockoutFailure({ kind, subject, reason: "login" });

// A failed step-up records through the SAME shared seam — same subject key, so it
// increments the same counter as a failed login for that subject.
export const recordStepUpFailure = (
  subject: string,
  kind: LockoutSubjectKind = "account"
): void => recordLockoutFailure({ kind, subject, reason: "step_up" });
