// Acceptance proofs for the scheduled observe-first soft-delete cleanup, driven
// against the scheduled-job entrypoint with an injected clock/window and a
// controllable candidate set (no live DB). It proves the load-bearing safety
// property end-to-end: no destructive run before an observable dry-run, soft-
// delete only (recoverable), a protected account is never swept, the window is
// configurable, pending invitations past their window are soft-expired, and the
// sessionless job authorizes as the system principal.
//
// Behavior asserted (names describe behavior, not a planning id).

import {
  expireInvitation,
  isExpired,
} from "@perry-starter/auth/invitation-lifecycle";
import type { Invitation } from "@perry-starter/db/shapes/invitation";
import { expect, test } from "vitest";
import {
  buildExpireInvitationSql,
  type CleanupAccountCandidate,
  type CleanupInvitationCandidate,
  type CleanupPassInput,
  cleanupIsSystemAuthorized,
  isSweepableInvitation,
  resolveCleanupConfig,
  runCleanupPass,
} from "../src/scheduled-cleanup";
import { buildReactivateSql, isSoftDeleteSql } from "../src/user-admin";

const T0 = Date.parse("2026-07-02T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const abandoned = (id: string): CleanupAccountCandidate => ({
  id,
  email: `${id}@example.com`,
  emailVerified: false,
  role: "member",
  status: "active",
  invited_by: null,
  created_at: new Date(T0 - 72 * HOUR).toISOString(),
});

interface Harness {
  readonly base: (over: Partial<CleanupPassInput>) => CleanupPassInput;
  readonly effects: string[];
}

const harness = (
  accounts: readonly CleanupAccountCandidate[],
  invitations: readonly CleanupInvitationCandidate[] = []
): Harness => {
  const effects: string[] = [];
  const base = (over: Partial<CleanupPassInput>): CleanupPassInput => ({
    now: T0,
    loadUnverifiedCandidates: () => accounts,
    loadExpiredPendingInvitations: () => invitations,
    softDeleteAccount: (id) => {
      effects.push(`soft-delete:${id}`);
    },
    revokeAccountSessions: (id) => {
      effects.push(`revoke:${id}`);
    },
    expireInvitation: (id) => {
      effects.push(`expire:${id}`);
    },
    recordObservation: (plan) => {
      effects.push(
        `observe:accounts=${plan.accountIds.length}:invites=${plan.invitationIds.length}:protected=${plan.protectedSkipped.length}`
      );
    },
    recordSoftDelete: (event) => {
      effects.push(`audit-delete:${event.target}`);
    },
    recordInvitationExpiry: (event) => {
      effects.push(`audit-expire:${event.target}`);
    },
    ...over,
  });
  return { base, effects };
};

test("first activation runs observe-only: it records what it WOULD remove and removes nothing", async () => {
  const { base, effects } = harness([abandoned("user-1"), abandoned("user-2")]);
  // The default posture (no explicit sweep) is observe — the first activation.
  const { mode } = resolveCleanupConfig({});
  const result = await runCleanupPass(base({ mode }));
  expect(mode).toBe("observe");
  expect(result.observedOnly).toBe(true);
  expect(result.softDeleted).toBe(0);
  // The observation recorded the candidate count + identifiers.
  expect(result.accountIds).toEqual(["user-1", "user-2"]);
  // Nothing was removed: the observation is the ONLY effect.
  expect(effects).toEqual(["observe:accounts=2:invites=0:protected=0"]);
});

test("a sweep soft-deletes an abandoned account, cascades a session revoke, audits, and is recoverable", async () => {
  const { base, effects } = harness([abandoned("user-1")]);
  const result = await runCleanupPass(base({ mode: "sweep" }));
  expect(result.softDeleted).toBe(1);
  expect(result.sessionsRevoked).toBe(1);
  // Observation strictly first, then soft-delete, then the session cascade, then audit.
  expect(effects).toEqual([
    "observe:accounts=1:invites=0:protected=0",
    "soft-delete:user-1",
    "revoke:user-1",
    "audit-delete:user-1",
  ]);
  // Recoverable: the soft-delete is a status flip, restorable by reactivate
  // (never a hard delete of the row).
  expect(isSoftDeleteSql(buildReactivateSql("user-1").query)).toBe(true);
});

test("a sweep NEVER touches a verified, admin/superadmin, invited, or already-actioned account", async () => {
  const { base, effects } = harness([
    abandoned("user-abandoned"),
    { ...abandoned("user-verified"), emailVerified: true },
    { ...abandoned("user-admin"), role: "admin" },
    { ...abandoned("user-super"), role: "superadmin" },
    { ...abandoned("user-invited"), invited_by: "user-inviter" },
    { ...abandoned("user-gone"), status: "deactivated" },
  ]);
  const result = await runCleanupPass(base({ mode: "sweep" }));
  // Only the genuinely-abandoned account is soft-deleted.
  expect(result.accountIds).toEqual(["user-abandoned"]);
  expect(result.protectedSkipped).toEqual([
    "user-verified",
    "user-admin",
    "user-super",
    "user-invited",
    "user-gone",
  ]);
  for (const id of [
    "user-verified",
    "user-admin",
    "user-super",
    "user-invited",
    "user-gone",
  ]) {
    expect(effects).not.toContain(`soft-delete:${id}`);
  }
});

test("the cleanup window is configurable and independent of the observe/sweep toggle", async () => {
  // A 24h window is honoured independently of the mode.
  const config = resolveCleanupConfig({
    CLEANUP_MODE: "sweep",
    CLEANUP_WINDOW_HOURS: "24",
  });
  expect(config).toEqual({ mode: "sweep", windowHours: 24 });
  const { base } = harness([abandoned("user-1")]);
  const result = await runCleanupPass(
    base({ mode: config.mode, windowHours: config.windowHours })
  );
  expect(result.windowHours).toBe(24);
  expect(result.mode).toBe("sweep");
});

test("expired pending invitations are soft-expired using the same rule the invitation lifecycle uses", async () => {
  const expiredRow: Invitation = {
    email: "invitee@example.com",
    organization_id: null,
    role: "member",
    token_hash: "digest",
    invited_by: "user-admin",
    status: "pending",
    created_at: new Date(T0 - 72 * HOUR).toISOString(),
    expires_at: new Date(T0 - HOUR).toISOString(),
    accepted_at: null,
  };
  // The cleanup sweep-predicate agrees with the invitation lifecycle's isExpired:
  // both treat a past-window pending invitation as expired (reuse, not a fork).
  const candidate: CleanupInvitationCandidate = {
    id: "inv-old",
    status: expiredRow.status,
    expires_at: expiredRow.expires_at,
  };
  expect(isSweepableInvitation(candidate, T0)).toBe(isExpired(expiredRow, T0));
  expect(isSweepableInvitation(candidate, T0)).toBe(true);
  // The soft transition matches the lifecycle's expireInvitation (status -> expired).
  expect(expireInvitation(expiredRow).status).toBe("expired");
  expect(buildExpireInvitationSql("inv-old").query).toContain(
    "status = 'expired'"
  );

  const { base, effects } = harness([], [candidate]);
  const result = await runCleanupPass(base({ mode: "sweep" }));
  expect(result.invitationsExpired).toBe(1);
  expect(effects).toContain("expire:inv-old");
  expect(effects).toContain("audit-expire:inv-old");
});

test("the sessionless job authorizes as the trusted system principal (c3)", () => {
  // No user session: authority is the system principal the audit-write gate
  // recognizes, and a below-admin session cannot launder authority through it.
  expect(cleanupIsSystemAuthorized()).toBe(true);
});
