// Mutation twin for step-up-coverage.gate.test.ts.
//
// It feeds the REAL coverage guard known-bad manifests and asserts each reddens,
// proving the guard is anti-vacuous: a dangerous action served on the plain
// (non-step-up) tier MUST be a violation, and a manifest that drops a real
// step-up-guarded procedure MUST be caught as drift. It also drives the good
// baseline to prove the guard stays green when every dangerous action is guarded.

import { expect, test } from "vitest";
import { STEP_UP_PROCEDURES } from "../index";
import {
  findUnguardedDangerousActions,
  guardedActionsOf,
  type StepUpManifest,
} from "../step-up-registry";

test("a dangerous action served on the plain (non-step-up) tier fails the guard", () => {
  const bad: StepUpManifest = { "role.change": "protected" };
  const violations = findUnguardedDangerousActions(bad);
  expect(violations.length).toBeGreaterThan(0);
  expect(violations).toContain("role.change");
});

test("invitation creation on the plain tier is likewise a violation", () => {
  expect(
    findUnguardedDangerousActions({ "invite.create": "protected" })
  ).toContain("invite.create");
});

test("a manifest that drops a real step-up-guarded procedure no longer matches the wired set (drift caught)", () => {
  // Simulate a manifest edit that left a wired dangerous procedure unlisted: the
  // guarded set diverges from the wired procedures, so the gate's equality check
  // would go RED.
  const drifted: StepUpManifest = { "role.change": "step-up" }; // invite.create dropped
  expect(new Set(guardedActionsOf(drifted))).not.toEqual(
    new Set(Object.values(STEP_UP_PROCEDURES))
  );
});

test("the good baseline stays green — every dangerous action guarded has no violation", () => {
  const good: StepUpManifest = {
    "invite.create": "step-up",
    "role.change": "step-up",
    // reserved future actions have no procedure yet — not a violation
  };
  expect(findUnguardedDangerousActions(good)).toEqual([]);
});
