// The scheduled, observe-first, soft-delete cleanup policy.
//
// A periodic sweep of abandoned sign-ups that is SAFE BY CONSTRUCTION:
//   - OBSERVE-FIRST — the pass records (audits) exactly what it WOULD remove
//     BEFORE any destructive action, in every mode. The default mode is `observe`
//     (dry-run): it removes nothing. A destructive sweep runs only behind an
//     explicit `sweep` toggle, and even then the observation is emitted strictly
//     first. No destructive action can precede the observation.
//   - SOFT-DELETE ONLY — an actioned account is a reversible status flip
//     (reusing the reversible-deactivate posture), never a hard DELETE/REMOVE; a
//     swept invitation is a soft transition to `expired`, never a delete. A
//     soft-deleted account is restorable.
//   - NEVER OVER-DELETES — a verified, admin/superadmin, invited, or
//     already-actioned account is excluded by a safe predicate that is the FINAL
//     authority on what may be touched (defense-in-depth over the select).
//   - SESSIONLESS SYSTEM AUTHORITY — the job runs with NO user session; its
//     authorizing identity is the trusted server/system principal the append-only
//     audit-write gate recognizes. It never fabricates a below-admin session to
//     launder authority, and it reaches cloud data only through the single
//     post-auth forwarder (the gatekeeper's runtime binding) — never a raw root
//     credential that skips the authorization layer.
//   - AUDITED — every pass records the candidate counts + identifiers, and every
//     soft-delete / invitation-expiry records its own append-only event.
//
// The decisions here are PURE over injected seams (a candidate set, an injected
// clock/window, and the store forwarders), so every boundary — the observe-first
// ordering, the protected-account exclusion, the window default, and the
// observe/sweep toggle independence — is driven deterministically without a live
// DB. The host (the scheduled cloud Worker) wires the forwarders.

import { holdsAdminSurface } from "@perry-starter/auth/rbac";
import {
  type AuditWriter,
  type AuditWriteSql,
  authorizeAuditWrite,
  buildAuditWriteSql,
} from "./audit-log";
import { buildDeactivateSql, type StatusUpdateSql } from "./user-admin";

// --- The configurable window + the observe/sweep toggle ----------------------

// The verification window: an unverified account is a cleanup candidate only once
// it is older than this many hours. Default 48h; operator-overridable via config
// (see `resolveCleanupConfig`). The single-literal default so an override is a
// constant swap.
export const CLEANUP_WINDOW_DEFAULT_HOURS = 48;

const MS_PER_HOUR = 60 * 60 * 1000;

// The two cleanup modes. `observe` (the default / fail-safe) is a dry-run: it
// records what it WOULD remove and removes nothing. `sweep` performs the soft
// delete — but only AFTER the observation. The toggle is INDEPENDENT of the
// window (two orthogonal knobs).
export type CleanupMode = "observe" | "sweep";

// The default mode is observe — a fresh activation (or any unset/unknown config)
// NEVER runs destructively.
export const CLEANUP_MODE_DEFAULT: CleanupMode = "observe";

export interface CleanupEnvConfig {
  readonly CLEANUP_MODE?: string;
  readonly CLEANUP_WINDOW_HOURS?: string;
}

export interface ResolvedCleanupConfig {
  readonly mode: CleanupMode;
  readonly windowHours: number;
}

// Resolve the config with an observe-first posture: only the explicit literal
// `sweep` enables destruction — anything else (unset, empty, a typo) resolves to
// `observe`. The window is resolved independently (a positive finite override,
// else the 48h default), so the observe/sweep toggle and the window never couple.
export const resolveCleanupConfig = (
  env: CleanupEnvConfig
): ResolvedCleanupConfig => {
  const mode: CleanupMode = env.CLEANUP_MODE === "sweep" ? "sweep" : "observe";
  const parsed = Number(env.CLEANUP_WINDOW_HOURS);
  const windowHours =
    Number.isFinite(parsed) && parsed > 0
      ? parsed
      : CLEANUP_WINDOW_DEFAULT_HOURS;
  return { mode, windowHours };
};

// --- The candidate shapes (the store projections) ----------------------------

export interface CleanupAccountCandidate {
  readonly created_at: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly id: string;
  readonly invited_by?: string | null;
  readonly role: string;
  readonly status: string;
}

export interface CleanupInvitationCandidate {
  readonly expires_at: string;
  readonly id: string;
  readonly status: string;
}

// --- The safe protected-account predicate (the never-over-delete guarantee) ---

// The FINAL authority on whether an account may be touched. It returns true
// (PROTECTED — never swept) for a verified account, an admin/superadmin, an
// invited account (any inviter recorded), or an already-actioned row (status no
// longer `active`). This is applied AFTER the select as defense-in-depth: even if
// a select leaked a protected row, the pass excludes it here.
export const isProtectedFromCleanup = (
  account: CleanupAccountCandidate
): boolean => {
  if (account.emailVerified) {
    return true;
  }
  if (holdsAdminSurface(account.role)) {
    return true;
  }
  const inviter = account.invited_by;
  if (inviter !== undefined && inviter !== null && inviter !== "") {
    return true;
  }
  return account.status !== "active";
};

// Whether a pending invitation is past its window at `now` — the same past-window
// rule the invitation lifecycle's `isExpired` guard uses (only a pending
// invitation past `expires_at` is sweepable). The soft transition it drives
// (`buildExpireInvitationSql`) mirrors the `expireInvitation` row transition
// (status -> `expired`, never a delete).
export const isSweepableInvitation = (
  candidate: CleanupInvitationCandidate,
  now: number
): boolean =>
  candidate.status === "pending" && now >= Date.parse(candidate.expires_at);

// --- The select builders (observe-safe — a read, never a mutation) -----------

export interface CleanupSelectSql {
  readonly query: string;
  readonly vars: Record<string, string>;
}

// The unverified-candidate select. It is a SELECT (never a mutation): it can run
// in the observe phase without removing anything. The cutoff (now - window) is a
// bound $var cast with type::datetime; the core narrowing (unverified + still
// active + older than the window) rides in the WHERE, and the full
// protected-account exclusion is enforced again in TS by `isProtectedFromCleanup`.
export const buildUnverifiedCandidateSelectSql = (input: {
  readonly now: number;
  readonly windowHours: number;
}): CleanupSelectSql => {
  const cutoffIso = new Date(
    input.now - input.windowHours * MS_PER_HOUR
  ).toISOString();
  const query =
    "SELECT id, email, emailVerified, role, status, invited_by, created_at FROM user WHERE emailVerified = false AND status = 'active' AND created_at < type::datetime($cutoff);";
  return { query, vars: { cutoff: cutoffIso } };
};

// The expired-pending-invitation select — pending invitations past their window.
// Also a SELECT (observe-safe).
export const buildExpiredPendingInvitationSelectSql = (input: {
  readonly now: number;
}): CleanupSelectSql => {
  const nowIso = new Date(input.now).toISOString();
  const query =
    "SELECT id, status, expires_at FROM invitation WHERE status = 'pending' AND expires_at < type::datetime($now);";
  return { query, vars: { now: nowIso } };
};

// --- The soft-delete / soft-expire builders (never a hard delete) ------------

// A record-id key charset conservative enough to inline into a type::record var-
// bound target (better-auth ids are alphanumeric + `-`/`_`).
const SAFE_RECORD_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

// The account soft-delete: reuse the reversible-deactivate posture (an UPDATE that
// flips `status`, never a hard DELETE), so a cleanup soft-delete is fully
// recoverable by the same reactivate path.
export const buildCleanupSoftDeleteSql = (userId: string): StatusUpdateSql =>
  buildDeactivateSql(userId);

// The invitation soft-expire: an UPDATE that flips the invitation `status` to
// `expired` (mirroring the `expireInvitation` transition), never a DELETE — so the
// invitation store stays tidy without ever destroying a row.
export const buildExpireInvitationSql = (
  invitationId: string
): StatusUpdateSql => {
  if (!SAFE_RECORD_KEY_RE.test(invitationId)) {
    throw new Error("invitation id must be a safe record-id key");
  }
  return {
    query:
      "UPDATE type::record('invitation', $id) SET status = 'expired' RETURN AFTER;",
    vars: { id: invitationId },
  };
};

// --- The sessionless system-context authority (c3) ---------------------------

// The scheduled job's authorizing identity: the trusted server/system principal
// the append-only audit-write gate recognizes. This is NOT a raw root credential
// that skips authorization — its audit writes are authorized by the SAME gate
// every privileged write uses, and it reaches cloud data only through the single
// post-auth forwarder.
export const CLEANUP_SYSTEM_CONTEXT: AuditWriter = { kind: "system" } as const;

// Prove the sessionless job authorizes as the system principal AND cannot
// downgrade to a fabricated below-admin session to sneak past the gate: system is
// authorized; a member session is rejected.
export const cleanupIsSystemAuthorized = (): boolean =>
  authorizeAuditWrite(CLEANUP_SYSTEM_CONTEXT) &&
  !authorizeAuditWrite({ kind: "session", role: "member" });

// --- The audit builders (every pass + every action is recorded) --------------

// The fixed system actor identity every cleanup audit event carries (the pass is
// sessionless — there is no human actor).
const CLEANUP_SYSTEM_ACTOR = {
  actor: "system",
  actor_email: "system@perry-starter.local",
  actor_role: "system",
  ip: "internal",
  user_agent: "scheduled-cleanup",
} as const;

// The Crockford base32 ULID mint for the append-only audit id (matches the
// audit_log ULID charset: excludes I/L/O/U). The sole entropy source is
// crypto.getRandomValues.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RADIX = 32;
const ULID_TIME_LEN = 10;
const ULID_RANDOM_LEN = 16;

export const mintAuditUlid = (now: number = Date.now()): string => {
  const chars = new Array<string>(ULID_TIME_LEN + ULID_RANDOM_LEN);
  let time = now;
  for (let i = ULID_TIME_LEN - 1; i >= 0; i -= 1) {
    chars[i] = CROCKFORD[time % ULID_RADIX] as string;
    time = Math.floor(time / ULID_RADIX);
  }
  const random = new Uint8Array(ULID_RANDOM_LEN);
  crypto.getRandomValues(random);
  for (let i = 0; i < ULID_RANDOM_LEN; i += 1) {
    chars[ULID_TIME_LEN + i] = CROCKFORD[
      (random[i] as number) % ULID_RADIX
    ] as string;
  }
  return chars.join("");
};

// The observation audit for a pass — the counts AND identifiers of what would be
// (or was) actioned, plus the mode and window. This is the observe-first record:
// it is written before any destructive action, in every mode.
export const buildCleanupObservationAudit = (
  id: string,
  plan: CleanupPlan
): AuditWriteSql =>
  buildAuditWriteSql(id, {
    action: "user.cleanup_observed",
    ...CLEANUP_SYSTEM_ACTOR,
    target_type: "cleanup_pass",
    target_id: `${plan.mode}:${plan.windowHours}h`,
    metadata: {
      mode: plan.mode,
      window_hours: plan.windowHours,
      account_candidates: plan.accountIds.length,
      invitation_candidates: plan.invitationIds.length,
      protected_skipped: plan.protectedSkipped.length,
      account_ids: plan.accountIds,
      invitation_ids: plan.invitationIds,
      protected_ids: plan.protectedSkipped,
    },
  });

// The per-account soft-delete audit event.
export const buildCleanupSoftDeleteAudit = (
  id: string,
  targetUserId: string
): AuditWriteSql =>
  buildAuditWriteSql(id, {
    action: "user.cleanup_soft_deleted",
    ...CLEANUP_SYSTEM_ACTOR,
    target_type: "user",
    target_id: targetUserId,
    metadata: { recoverable: true },
  });

// The per-invitation soft-expiry audit event.
export const buildCleanupInvitationExpiryAudit = (
  id: string,
  invitationId: string
): AuditWriteSql =>
  buildAuditWriteSql(id, {
    action: "admin.invitation_expired",
    ...CLEANUP_SYSTEM_ACTOR,
    target_type: "invitation",
    target_id: invitationId,
    metadata: { swept: true },
  });

// --- The observe-before-destroy ordering checker (anti-vacuous gate seam) -----

// The ordered kinds of effect a cleanup pass emits.
export type CleanupEffect =
  | "observe"
  | "soft-delete"
  | "revoke-sessions"
  | "expire-invitation";

// A pure checker: the observation MUST exist and MUST strictly precede any
// destructive effect. An empty destructive tail (observe-only) passes; a
// destructive effect before (or without) the observation fails. The gate feeds
// this the real effect log recorded during a pass; the mutation twin feeds it a
// known-bad ordering.
export const observationPrecedesDestruction = (
  log: readonly CleanupEffect[]
): boolean => {
  const firstObserve = log.indexOf("observe");
  if (firstObserve === -1) {
    return false;
  }
  const firstDestructive = log.findIndex((effect) => effect !== "observe");
  if (firstDestructive === -1) {
    return true;
  }
  return firstObserve < firstDestructive;
};

// A guard proving a select builder is observe-safe: it is a read (SELECT) and
// carries no mutation verb.
const SELECT_RE = /^\s*SELECT\b/i;
const MUTATION_VERB_RE = /\b(?:UPDATE|CREATE|DELETE|REMOVE|UPSERT|INSERT)\b/i;
export const isObserveSafeSelect = (query: string): boolean =>
  SELECT_RE.test(query) && !MUTATION_VERB_RE.test(query);

// --- The observe-first orchestrator ------------------------------------------

export interface CleanupPlan {
  // The actionable account ids (would-be soft-deletes in observe mode; the
  // soft-deleted set in sweep mode) after the protected-account exclusion.
  readonly accountIds: readonly string[];
  // The sweepable pending-invitation ids past their window.
  readonly invitationIds: readonly string[];
  readonly mode: CleanupMode;
  // The candidate ids the safe predicate EXCLUDED (verified/admin/invited/
  // already-actioned) — proof the never-over-delete guarantee ran.
  readonly protectedSkipped: readonly string[];
  readonly windowHours: number;
}

export interface CleanupResult extends CleanupPlan {
  readonly invitationsExpired: number;
  readonly observedOnly: boolean;
  readonly sessionsRevoked: number;
  readonly softDeleted: number;
}

export interface CleanupPassInput {
  readonly expireInvitation: (invitationId: string) => Promise<void> | void;
  readonly loadExpiredPendingInvitations: () =>
    | Promise<readonly CleanupInvitationCandidate[]>
    | readonly CleanupInvitationCandidate[];
  // The store reads (observe-safe SELECT forwarders).
  readonly loadUnverifiedCandidates: () =>
    | Promise<readonly CleanupAccountCandidate[]>
    | readonly CleanupAccountCandidate[];
  // The mode; defaults to observe (dry-run) when omitted — fail-safe.
  readonly mode?: CleanupMode;
  readonly now: number;
  readonly recordInvitationExpiry: (event: {
    readonly target: string;
  }) => Promise<void> | void;
  // The audit forwarders — the observation (written first, every mode) and the
  // per-action events (sweep mode only).
  readonly recordObservation: (plan: CleanupPlan) => Promise<void> | void;
  readonly recordSoftDelete: (event: {
    readonly target: string;
  }) => Promise<void> | void;
  readonly revokeAccountSessions: (userId: string) => Promise<void> | void;
  // The destructive forwarders — invoked ONLY in sweep mode, ONLY after the
  // observation. A soft status flip (never a hard delete), a session cascade, and
  // a soft invitation-expiry.
  readonly softDeleteAccount: (userId: string) => Promise<void> | void;
  // The window in hours; defaults to 48 when omitted.
  readonly windowHours?: number;
}

// Run one cleanup pass. Observe-first is structural: the observation audit is
// emitted before any destructive forwarder is ever called, in EVERY mode; in
// observe mode no destructive forwarder is called at all.
export const runCleanupPass = async (
  input: CleanupPassInput
): Promise<CleanupResult> => {
  const mode = input.mode ?? CLEANUP_MODE_DEFAULT;
  const windowHours = input.windowHours ?? CLEANUP_WINDOW_DEFAULT_HOURS;

  const rawAccounts = await input.loadUnverifiedCandidates();
  const rawInvitations = await input.loadExpiredPendingInvitations();

  // The safe predicate is the FINAL authority: a protected account is excluded
  // here even if a select leaked it.
  const actionable: CleanupAccountCandidate[] = [];
  const protectedSkipped: string[] = [];
  for (const account of rawAccounts) {
    if (isProtectedFromCleanup(account)) {
      protectedSkipped.push(account.id);
    } else {
      actionable.push(account);
    }
  }
  const sweepableInvitations = rawInvitations.filter((candidate) =>
    isSweepableInvitation(candidate, input.now)
  );

  const plan: CleanupPlan = {
    mode,
    windowHours,
    accountIds: actionable.map((account) => account.id),
    invitationIds: sweepableInvitations.map((invitation) => invitation.id),
    protectedSkipped,
  };

  // OBSERVE-FIRST — record exactly what would be removed BEFORE any destructive
  // action. No soft-delete can precede this.
  await input.recordObservation(plan);

  if (mode === "observe") {
    // Dry-run: the observation is the only effect; nothing is removed.
    return {
      ...plan,
      observedOnly: true,
      softDeleted: 0,
      sessionsRevoked: 0,
      invitationsExpired: 0,
    };
  }

  // Sweep — strictly AFTER the observation.
  let sessionsRevoked = 0;
  for (const account of actionable) {
    await input.softDeleteAccount(account.id); // soft status flip, never a hard delete
    await input.revokeAccountSessions(account.id); // cascade
    sessionsRevoked += 1;
    await input.recordSoftDelete({ target: account.id });
  }
  for (const invitation of sweepableInvitations) {
    await input.expireInvitation(invitation.id); // soft flip to expired, never a delete
    await input.recordInvitationExpiry({ target: invitation.id });
  }

  return {
    ...plan,
    observedOnly: false,
    softDeleted: actionable.length,
    sessionsRevoked,
    invitationsExpired: sweepableInvitations.length,
  };
};
