// Mutation twin for invitation-step-up.gate.test.ts.
//
// It feeds the REAL coverage guard a known-bad manifest and asserts it reddens,
// proving the guard is anti-vacuous: an invitation token-issuing action served on
// the plain (non-step-up) tier MUST be a violation. It also drives the good baseline
// (the invitation dangerous action guarded) to prove the guard stays green.

import { expect, test } from "vitest";

import { INVITATION_STEP_UP_PROCEDURES } from "../invitations";
import { findUnguardedDangerousActions } from "../step-up-registry";

test("the invite.create action served on the plain tier fails the guard", () => {
  const violations = findUnguardedDangerousActions({
    "invite.create": "protected",
  });
  expect(violations).toContain("invite.create");
});

test("the good baseline stays green — the invitation dangerous action is guarded", () => {
  const good: Record<string, "step-up"> = {};
  for (const action of Object.values(INVITATION_STEP_UP_PROCEDURES)) {
    good[action] = "step-up";
  }
  expect(findUnguardedDangerousActions(good)).toEqual([]);
});
