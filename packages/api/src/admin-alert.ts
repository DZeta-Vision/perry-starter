// The admin-alert on repeated failed logins — the PURE threshold-cross decision
// plus the enumeration-safe audit event + notification body it produces.
//
// When the strongly-consistent Durable-Object lockout counter (the authoritative
// throttle) observes a subject cross the escalation boundary, an admin is notified
// AND the event is appended to the immutable audit log through the same
// `<domain>.<verb>` vocabulary + the forwarder-backed `writeAudit` sink. This
// module owns only the DECISION and the SHAPING; the worker glue injects the live
// forwarder + notification channel.
//
// Two invariants are load-bearing (each has a mutation twin):
//   - FIRE ONCE AT THE BOUNDARY: the alert fires exactly when the post-increment
//     count first EQUALS the lock threshold — never on every subsequent attempt
//     (which would spam an admin and drown the signal).
//   - ENUMERATION-SAFE: the notification body reveals nothing an admin is not
//     authorized to see — no "this email is / isn't registered". The lockout fires
//     identically for registered and unregistered subjects (the counter is blind),
//     so the body carries no registration language and no secret-bearing field.

import type { LockoutThresholds } from "@perry-starter/auth/lockout-policy";
import { DEFAULT_LOCKOUT_THRESHOLDS } from "@perry-starter/auth/lockout-policy";
import { isSecretFree } from "@perry-starter/env/scrub";

import type { AuditWriteInput } from "./audit-log";

// The audit action for a lockout escalation — inside the closed `lockout.*` domain.
export const LOCKOUT_ESCALATION_ACTION = "lockout.escalation";

// The two independent lockout perimeters (per-account vs per-IP).
export type LockoutAlertPerimeter = "account" | "ip";

// The subject a counter keyed on — the normalized account email or the client IP.
export interface AdminAlertSubject {
  readonly kind: LockoutAlertPerimeter;
  readonly subject: string;
}

// Optional request context folded into the audit row (sentinels when absent — a
// system-generated alert has no real UA).
export interface LockoutAlertContext {
  readonly ip?: string;
  readonly userAgent?: string;
}

// The admin-facing notification. `subject`/`count`/`threshold` are structured
// fields an admin is authorized to see; `title`/`body` are the human-readable text
// that must stay enumeration-neutral.
export interface AdminAlertNotification {
  readonly body: string;
  readonly count: number;
  readonly perimeter: LockoutAlertPerimeter;
  readonly subject: string;
  readonly threshold: number;
  readonly title: string;
}

export type LockoutAlertDecision =
  | { readonly fire: false }
  | {
      readonly audit: AuditWriteInput;
      readonly fire: true;
      readonly notification: AdminAlertNotification;
    };

// The system principal recorded as the actor of a throttle-fired alert (the event
// is machine-generated, not user-initiated). A valid sentinel email, not a subject.
const SYSTEM_ACTOR = "system";
const SYSTEM_ACTOR_EMAIL = "system@perry-starter.local";
const SYSTEM_ACTOR_ROLE = "system";
const UNKNOWN = "unknown";

const ALERT_TITLE = "Repeated failed sign-in attempts";
// Neutral by construction: it states the escalation happened, never whether the
// subject is a registered account.
const ALERT_BODY =
  "A sign-in subject reached the failed-login escalation threshold; further attempts are temporarily rate-limited.";

// Registration/existence-revealing phrasings that must never appear in a body.
const ENUMERATION_TOKENS: readonly RegExp[] = [
  /registered/i,
  /unregistered/i,
  /not\s+found/i,
  /no\s+such/i,
  /does\s+not\s+exist/i,
  /already\s+exists/i,
  /account\s+exists/i,
];

// Fire exactly once — when the post-increment count FIRST equals the lock
// threshold. A strict equality (not `>=`) is what makes it fire once at the
// boundary rather than on every attempt past it.
export const shouldEmitLockoutAlert = (
  count: number,
  thresholds: LockoutThresholds = DEFAULT_LOCKOUT_THRESHOLDS
): boolean => count === thresholds.lockAt;

// Build the enumeration-safe audit append for a lockout escalation. The subject is
// the TARGET (admin-authorized); the actor is the system principal. No credential,
// no registration flag — only the perimeter + count + threshold.
export const buildLockoutAlertAudit = (
  subjectCtx: AdminAlertSubject,
  count: number,
  thresholds: LockoutThresholds = DEFAULT_LOCKOUT_THRESHOLDS,
  ctx: LockoutAlertContext = {}
): AuditWriteInput => ({
  action: LOCKOUT_ESCALATION_ACTION,
  actor: SYSTEM_ACTOR,
  actor_email: SYSTEM_ACTOR_EMAIL,
  actor_role: SYSTEM_ACTOR_ROLE,
  ip: ctx.ip ?? UNKNOWN,
  metadata: {
    count,
    perimeter: subjectCtx.kind,
    threshold: thresholds.lockAt,
  },
  target_id: subjectCtx.subject,
  target_type: subjectCtx.kind,
  user_agent: ctx.userAgent ?? SYSTEM_ACTOR,
});

// Build the admin notification body. Neutral text; structured fields only.
export const buildLockoutAlertNotification = (
  subjectCtx: AdminAlertSubject,
  count: number,
  thresholds: LockoutThresholds = DEFAULT_LOCKOUT_THRESHOLDS
): AdminAlertNotification => ({
  body: ALERT_BODY,
  count,
  perimeter: subjectCtx.kind,
  subject: subjectCtx.subject,
  threshold: thresholds.lockAt,
  title: ALERT_TITLE,
});

// The enumeration-safety guard the gate asserts: the human-readable text carries
// no registration/existence language, and the whole notification carries no
// secret-bearing field (reusing the shared scrubber invariant).
export const isEnumerationSafeNotification = (
  notification: AdminAlertNotification
): boolean => {
  const text = `${notification.title}\n${notification.body}`;
  const noEnumerationLeak = !ENUMERATION_TOKENS.some((re) => re.test(text));
  return noEnumerationLeak && isSecretFree(notification);
};

// The pure decision: on a threshold-cross, produce BOTH the audit append and the
// enumeration-safe notification; otherwise fire nothing.
export const evaluateLockoutAlert = (
  count: number,
  subjectCtx: AdminAlertSubject,
  thresholds: LockoutThresholds = DEFAULT_LOCKOUT_THRESHOLDS,
  ctx: LockoutAlertContext = {}
): LockoutAlertDecision => {
  if (!shouldEmitLockoutAlert(count, thresholds)) {
    return { fire: false };
  }
  return {
    audit: buildLockoutAlertAudit(subjectCtx, count, thresholds, ctx),
    fire: true,
    notification: buildLockoutAlertNotification(subjectCtx, count, thresholds),
  };
};
