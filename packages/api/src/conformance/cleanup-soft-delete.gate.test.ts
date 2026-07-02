// Conformance gate for the scheduled cleanup: it is observe-first and
// soft-delete-only by construction.
//
// Two load-bearing safety properties are asserted against the SHIPPED policy:
//   1. observe-before-destroy — a real cleanup pass emits its observation strictly
//      before any destructive effect (and, in observe mode, emits no destructive
//      effect at all), proven via the pure `observationPrecedesDestruction`
//      ordering checker fed the pass's real effect log.
//   2. soft-delete-only — the account and invitation builders are soft status
//      flips (`isSoftDeleteSql` true, no hard DELETE/REMOVE), and the candidate
//      selects are observe-safe reads.
// The gate is non-vacuous: a real sweep DOES soft-delete the actionable account,
// so a policy that removed nothing would not satisfy it. The mutation twin
// (cleanup-soft-delete.mutation.test.ts) feeds the SAME checkers known-bad input.

import { expect, test } from "vitest";
import {
  buildCleanupSoftDeleteSql,
  buildExpiredPendingInvitationSelectSql,
  buildExpireInvitationSql,
  buildUnverifiedCandidateSelectSql,
  type CleanupEffect,
  isObserveSafeSelect,
  observationPrecedesDestruction,
  runCleanupPass,
} from "../scheduled-cleanup";
import { isSoftDeleteSql } from "../user-admin";

const T0 = Date.parse("2026-07-02T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const abandoned = {
  id: "user-abandoned",
  email: "abandoned@example.com",
  emailVerified: false,
  role: "member",
  status: "active",
  invited_by: null,
  created_at: new Date(T0 - 72 * HOUR).toISOString(),
} as const;

// Run a pass and capture its ordered effect log for the ordering checker.
const passEffects = async (
  mode: "observe" | "sweep"
): Promise<CleanupEffect[]> => {
  const log: CleanupEffect[] = [];
  await runCleanupPass({
    mode,
    now: T0,
    loadUnverifiedCandidates: () => [abandoned],
    loadExpiredPendingInvitations: () => [],
    softDeleteAccount: () => {
      log.push("soft-delete");
    },
    revokeAccountSessions: () => {
      log.push("revoke-sessions");
    },
    expireInvitation: () => {
      log.push("expire-invitation");
    },
    recordObservation: () => {
      log.push("observe");
    },
    recordSoftDelete: () => undefined,
    recordInvitationExpiry: () => undefined,
  });
  return log;
};

test("a real sweep emits the observation before any destructive effect", async () => {
  const log = await passEffects("sweep");
  expect(observationPrecedesDestruction(log)).toBe(true);
  // Non-vacuous: the sweep actually destroyed something (a soft-delete occurred).
  expect(log).toContain("soft-delete");
  expect(log[0]).toBe("observe");
});

test("observe mode emits the observation and no destructive effect at all", async () => {
  const log = await passEffects("observe");
  expect(observationPrecedesDestruction(log)).toBe(true);
  expect(log).toEqual(["observe"]);
});

test("the account + invitation builders are soft-delete only (never a hard delete)", () => {
  expect(
    isSoftDeleteSql(buildCleanupSoftDeleteSql("user-abandoned").query)
  ).toBe(true);
  expect(isSoftDeleteSql(buildExpireInvitationSql("inv-1").query)).toBe(true);
});

test("the candidate selects are observe-safe reads", () => {
  expect(
    isObserveSafeSelect(
      buildUnverifiedCandidateSelectSql({ now: T0, windowHours: 48 }).query
    )
  ).toBe(true);
  expect(
    isObserveSafeSelect(
      buildExpiredPendingInvitationSelectSql({ now: T0 }).query
    )
  ).toBe(true);
});
