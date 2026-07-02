// Mutation twin for cleanup-soft-delete.gate.test.ts.
//
// It feeds the REAL checkers known-bad input and asserts they redden, proving the
// gate is anti-vacuous:
//   - a destructive-before-observe ordering (or an observation-less pass) MUST
//     fail `observationPrecedesDestruction`;
//   - a hard DELETE/REMOVE builder MUST fail `isSoftDeleteSql`;
//   - a mutating query MUST fail `isObserveSafeSelect`.
// The good baselines stay green.

import { expect, test } from "vitest";
import {
  type CleanupEffect,
  isObserveSafeSelect,
  observationPrecedesDestruction,
} from "../scheduled-cleanup";
import { isSoftDeleteSql } from "../user-admin";

test("a soft-delete before the observation fails the ordering checker", () => {
  const bad: CleanupEffect[] = ["soft-delete", "observe"];
  expect(observationPrecedesDestruction(bad)).toBe(false);
});

test("a pass with no observation at all fails the ordering checker", () => {
  const bad: CleanupEffect[] = ["soft-delete", "revoke-sessions"];
  expect(observationPrecedesDestruction(bad)).toBe(false);
});

test("the good ordering (observation first) stays green", () => {
  const good: CleanupEffect[] = ["observe", "soft-delete", "revoke-sessions"];
  expect(observationPrecedesDestruction(good)).toBe(true);
});

test("a hard-delete builder fails the soft-delete guard", () => {
  const hardDelete = "DELETE type::record('user', $id) RETURN BEFORE;";
  expect(isSoftDeleteSql(hardDelete)).toBe(false);
  // A REMOVE dressed up with a status SET is still not soft.
  const remove = "REMOVE TABLE user; UPDATE user SET status = 'expired';";
  expect(isSoftDeleteSql(remove)).toBe(false);
});

test("a mutating query fails the observe-safe-select guard", () => {
  expect(isObserveSafeSelect("UPDATE user SET status = 'deactivated';")).toBe(
    false
  );
  expect(isObserveSafeSelect("DELETE user WHERE emailVerified = false;")).toBe(
    false
  );
  // The good baseline: a plain SELECT is observe-safe.
  expect(
    isObserveSafeSelect("SELECT id FROM user WHERE status = 'active';")
  ).toBe(true);
});
