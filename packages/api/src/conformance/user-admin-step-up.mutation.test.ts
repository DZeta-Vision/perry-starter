// Mutation twin for user-admin-step-up.gate.test.ts.
//
// It feeds the REAL coverage guard known-bad manifests and asserts each reddens,
// proving the guard is anti-vacuous: a user-admin dangerous action served on the
// plain (non-step-up) tier MUST be a violation. It also drives the good baseline
// (both user-admin dangerous actions guarded) to prove the guard stays green.

import { expect, test } from "vitest";

import { findUnguardedDangerousActions } from "../step-up-registry";
import { USER_ADMIN_STEP_UP_PROCEDURES } from "../user-admin";

test("the deactivate (ban) action served on the plain tier fails the guard", () => {
  const violations = findUnguardedDangerousActions({ "user.ban": "protected" });
  expect(violations).toContain("user.ban");
});

test("the role-change action served on the plain tier fails the guard", () => {
  const violations = findUnguardedDangerousActions({
    "role.change": "protected",
  });
  expect(violations).toContain("role.change");
});

test("the good baseline stays green — both user-admin dangerous actions guarded", () => {
  const good: Record<string, "step-up"> = {};
  for (const action of Object.values(USER_ADMIN_STEP_UP_PROCEDURES)) {
    good[action] = "step-up";
  }
  expect(findUnguardedDangerousActions(good)).toEqual([]);
});
