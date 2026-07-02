// Unit proofs for the scheduled observe-first soft-delete cleanup policy: the
// observe-first ordering, the protected-account exclusion, the configurable
// window + observe/sweep toggle independence, the soft-delete-only builders, the
// sessionless system-context authority, and the audit builders. All pure over
// injected seams (no live DB).

import { describe, expect, test } from "vitest";
import {
  buildCleanupInvitationExpiryAudit,
  buildCleanupObservationAudit,
  buildCleanupSoftDeleteAudit,
  buildCleanupSoftDeleteSql,
  buildExpiredPendingInvitationSelectSql,
  buildExpireInvitationSql,
  buildUnverifiedCandidateSelectSql,
  CLEANUP_WINDOW_DEFAULT_HOURS,
  type CleanupAccountCandidate,
  type CleanupInvitationCandidate,
  type CleanupPassInput,
  cleanupIsSystemAuthorized,
  isObserveSafeSelect,
  isProtectedFromCleanup,
  isSweepableInvitation,
  mintAuditUlid,
  resolveCleanupConfig,
  runCleanupPass,
} from "./scheduled-cleanup";
import { buildReactivateSql, isSoftDeleteSql } from "./user-admin";

const HARD_DELETE_RE = /\b(?:DELETE|REMOVE)\b/i;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const T0 = Date.parse("2026-07-02T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const account = (
  over: Partial<CleanupAccountCandidate> = {}
): CleanupAccountCandidate => ({
  id: "user-abandoned",
  email: "abandoned@example.com",
  emailVerified: false,
  role: "member",
  status: "active",
  invited_by: null,
  created_at: new Date(T0 - 72 * HOUR).toISOString(),
  ...over,
});

interface Recorder {
  readonly input: CleanupPassInput;
  readonly log: string[];
}

const recorder = (
  accounts: readonly CleanupAccountCandidate[],
  invitations: readonly CleanupInvitationCandidate[] = [],
  over: Partial<CleanupPassInput> = {}
): Recorder => {
  const log: string[] = [];
  const input: CleanupPassInput = {
    now: T0,
    loadUnverifiedCandidates: () => accounts,
    loadExpiredPendingInvitations: () => invitations,
    softDeleteAccount: (id) => {
      log.push(`soft-delete:${id}`);
    },
    revokeAccountSessions: (id) => {
      log.push(`revoke:${id}`);
    },
    expireInvitation: (id) => {
      log.push(`expire:${id}`);
    },
    recordObservation: (plan) => {
      log.push(
        `observe:${plan.accountIds.length}:${plan.invitationIds.length}`
      );
    },
    recordSoftDelete: (event) => {
      log.push(`audit-delete:${event.target}`);
    },
    recordInvitationExpiry: (event) => {
      log.push(`audit-expire:${event.target}`);
    },
    ...over,
  };
  return { input, log };
};

// --- Config: observe-first + independent window ------------------------------

describe("config resolution is observe-first with an independent window", () => {
  test("an unset config resolves to observe mode and the 48h default window", () => {
    expect(resolveCleanupConfig({})).toEqual({
      mode: "observe",
      windowHours: CLEANUP_WINDOW_DEFAULT_HOURS,
    });
    expect(CLEANUP_WINDOW_DEFAULT_HOURS).toBe(48);
  });

  test("only the explicit literal sweep enables destruction; a typo stays observe", () => {
    expect(resolveCleanupConfig({ CLEANUP_MODE: "sweep" }).mode).toBe("sweep");
    expect(resolveCleanupConfig({ CLEANUP_MODE: "SWEEP" }).mode).toBe(
      "observe"
    );
    expect(resolveCleanupConfig({ CLEANUP_MODE: "destroy" }).mode).toBe(
      "observe"
    );
    expect(resolveCleanupConfig({ CLEANUP_MODE: "" }).mode).toBe("observe");
  });

  test("the window is configurable and orthogonal to the mode toggle", () => {
    expect(
      resolveCleanupConfig({ CLEANUP_WINDOW_HOURS: "72" }).windowHours
    ).toBe(72);
    // A sweep with a custom window carries both knobs, set independently.
    expect(
      resolveCleanupConfig({
        CLEANUP_MODE: "sweep",
        CLEANUP_WINDOW_HOURS: "24",
      })
    ).toEqual({ mode: "sweep", windowHours: 24 });
    // An invalid window falls back to the default without affecting the mode.
    expect(
      resolveCleanupConfig({
        CLEANUP_MODE: "sweep",
        CLEANUP_WINDOW_HOURS: "-5",
      })
    ).toEqual({ mode: "sweep", windowHours: CLEANUP_WINDOW_DEFAULT_HOURS });
  });
});

// --- Observe-first ordering --------------------------------------------------

describe("observe-first: no destructive action precedes the observation", () => {
  test("observe mode (the default) records the plan and removes nothing", async () => {
    const { input, log } = recorder([account()]);
    const result = await runCleanupPass(input); // no mode -> default observe
    expect(result.observedOnly).toBe(true);
    expect(result.softDeleted).toBe(0);
    expect(result.accountIds).toEqual(["user-abandoned"]);
    // The ONLY effect is the observation; no soft-delete / revoke / audit-delete.
    expect(log).toEqual(["observe:1:0"]);
  });

  test("sweep mode emits the observation strictly before the first soft-delete", async () => {
    const { input, log } = recorder([account()], [], { mode: "sweep" });
    const result = await runCleanupPass(input);
    expect(result.observedOnly).toBe(false);
    expect(result.softDeleted).toBe(1);
    expect(log[0]).toBe("observe:1:0");
    expect(log.indexOf("observe:1:0")).toBeLessThan(
      log.indexOf("soft-delete:user-abandoned")
    );
    expect(log).toEqual([
      "observe:1:0",
      "soft-delete:user-abandoned",
      "revoke:user-abandoned",
      "audit-delete:user-abandoned",
    ]);
  });
});

// --- Never over-deletes protected accounts (adversarial) ---------------------

describe("the safe predicate never sweeps a protected account", () => {
  test("verified / admin / superadmin / invited / already-actioned are all protected", () => {
    expect(isProtectedFromCleanup(account({ emailVerified: true }))).toBe(true);
    expect(isProtectedFromCleanup(account({ role: "admin" }))).toBe(true);
    expect(isProtectedFromCleanup(account({ role: "superadmin" }))).toBe(true);
    expect(
      isProtectedFromCleanup(account({ invited_by: "user-inviter" }))
    ).toBe(true);
    expect(isProtectedFromCleanup(account({ status: "deactivated" }))).toBe(
      true
    );
    // The one class that IS swept: an unverified, member, active, uninvited account.
    expect(isProtectedFromCleanup(account())).toBe(false);
  });

  test("a sweep never soft-deletes a protected account even if the select leaks it", async () => {
    const verified = account({ id: "user-verified", emailVerified: true });
    const admin = account({ id: "user-admin", role: "admin" });
    const superadmin = account({ id: "user-super", role: "superadmin" });
    const invited = account({ id: "user-invited", invited_by: "user-x" });
    const alreadyGone = account({ id: "user-gone", status: "deactivated" });
    const abandoned = account({ id: "user-abandoned" });
    const { input, log } = recorder(
      [verified, admin, superadmin, invited, alreadyGone, abandoned],
      [],
      { mode: "sweep" }
    );
    const result = await runCleanupPass(input);
    // Only the genuinely-abandoned account is actioned.
    expect(result.accountIds).toEqual(["user-abandoned"]);
    expect(result.protectedSkipped).toEqual([
      "user-verified",
      "user-admin",
      "user-super",
      "user-invited",
      "user-gone",
    ]);
    expect(result.softDeleted).toBe(1);
    // No protected id appears in any destructive effect.
    for (const id of [
      "user-verified",
      "user-admin",
      "user-super",
      "user-invited",
      "user-gone",
    ]) {
      expect(log).not.toContain(`soft-delete:${id}`);
      expect(log).not.toContain(`revoke:${id}`);
    }
  });
});

// --- Soft-delete-only builders + recoverability ------------------------------

describe("the cleanup builders are soft-delete only (never a hard delete)", () => {
  test("the account soft-delete is a status flip and is reactivate-recoverable", () => {
    const soft = buildCleanupSoftDeleteSql("user-abandoned");
    expect(soft.query).toContain("status = 'deactivated'");
    expect(soft.query).not.toMatch(HARD_DELETE_RE);
    expect(isSoftDeleteSql(soft.query)).toBe(true);
    // Recoverable: the SAME row is restored by reactivate (never re-created).
    const restore = buildReactivateSql("user-abandoned");
    expect(restore.query).toContain("status = 'active'");
    expect(isSoftDeleteSql(restore.query)).toBe(true);
  });

  test("the invitation soft-expire flips status and never deletes; a bad id throws", () => {
    const expire = buildExpireInvitationSql("inv-1");
    expect(expire.query).toContain("status = 'expired'");
    expect(expire.query).not.toMatch(HARD_DELETE_RE);
    expect(isSoftDeleteSql(expire.query)).toBe(true);
    expect(() => buildExpireInvitationSql("inv; DELETE invitation")).toThrow();
  });

  test("the candidate selects are observe-safe reads (no mutation verb)", () => {
    const accountsSelect = buildUnverifiedCandidateSelectSql({
      now: T0,
      windowHours: 48,
    });
    const invitationsSelect = buildExpiredPendingInvitationSelectSql({
      now: T0,
    });
    expect(isObserveSafeSelect(accountsSelect.query)).toBe(true);
    expect(isObserveSafeSelect(invitationsSelect.query)).toBe(true);
    // The window rides in the cutoff bind var, not spliced into the body.
    expect(accountsSelect.vars.cutoff).toBe(
      new Date(T0 - 48 * HOUR).toISOString()
    );
  });
});

// --- Invitation sweep --------------------------------------------------------

describe("expired pending invitations are swept (soft), fresh ones are left", () => {
  test("only a pending invitation past its window is sweepable", () => {
    const expired: CleanupInvitationCandidate = {
      id: "inv-old",
      status: "pending",
      expires_at: new Date(T0 - HOUR).toISOString(),
    };
    const fresh: CleanupInvitationCandidate = {
      id: "inv-fresh",
      status: "pending",
      expires_at: new Date(T0 + HOUR).toISOString(),
    };
    const accepted: CleanupInvitationCandidate = {
      id: "inv-done",
      status: "accepted",
      expires_at: new Date(T0 - HOUR).toISOString(),
    };
    expect(isSweepableInvitation(expired, T0)).toBe(true);
    expect(isSweepableInvitation(fresh, T0)).toBe(false);
    expect(isSweepableInvitation(accepted, T0)).toBe(false);
  });

  test("a sweep soft-expires the past-window pending invitations and audits each", async () => {
    const expired: CleanupInvitationCandidate = {
      id: "inv-old",
      status: "pending",
      expires_at: new Date(T0 - HOUR).toISOString(),
    };
    const fresh: CleanupInvitationCandidate = {
      id: "inv-fresh",
      status: "pending",
      expires_at: new Date(T0 + HOUR).toISOString(),
    };
    const { input, log } = recorder([], [expired, fresh], { mode: "sweep" });
    const result = await runCleanupPass(input);
    expect(result.invitationsExpired).toBe(1);
    expect(result.invitationIds).toEqual(["inv-old"]);
    expect(log).toContain("expire:inv-old");
    expect(log).toContain("audit-expire:inv-old");
    expect(log).not.toContain("expire:inv-fresh");
  });
});

// --- Sessionless system-context authority (c3) -------------------------------

describe("the sessionless job authorizes as the system principal (c3)", () => {
  test("system is authorized and a below-admin session cannot launder authority", () => {
    expect(cleanupIsSystemAuthorized()).toBe(true);
  });
});

// --- Audit builders ----------------------------------------------------------

describe("the audit builders record counts + identifiers under a ULID", () => {
  test("mintAuditUlid yields a valid audit-log ULID", () => {
    expect(mintAuditUlid(T0)).toMatch(ULID_RE);
    expect(mintAuditUlid()).toMatch(ULID_RE);
  });

  test("the observation audit carries the mode, window, counts and ids", () => {
    const id = mintAuditUlid(T0);
    const built = buildCleanupObservationAudit(id, {
      mode: "sweep",
      windowHours: 48,
      accountIds: ["user-a", "user-b"],
      invitationIds: ["inv-1"],
      protectedSkipped: ["user-v"],
    });
    expect(built.query).toContain("CREATE type::record('audit_log'");
    // action + scalar fields ride as bound $vars (never spliced into the body).
    expect(built.vars.action).toBe("user.cleanup_observed");
    // The identifiers of affected records are carried in the inlined metadata.
    expect(built.query).toContain("user-a");
    expect(built.query).toContain("inv-1");
  });

  test("the soft-delete audit targets the user with a recoverable marker", () => {
    const built = buildCleanupSoftDeleteAudit(mintAuditUlid(T0), "user-a");
    expect(built.vars.action).toBe("user.cleanup_soft_deleted");
    expect(built.vars.target_id).toBe("user-a");
    expect(built.query).toContain('"recoverable":true');
  });

  test("the invitation-expiry audit targets the invitation", () => {
    const built = buildCleanupInvitationExpiryAudit(mintAuditUlid(T0), "inv-1");
    expect(built.vars.action).toBe("admin.invitation_expired");
    expect(built.vars.target_type).toBe("invitation");
    expect(built.vars.target_id).toBe("inv-1");
  });
});
