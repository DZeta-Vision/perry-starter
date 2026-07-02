// The step-up coverage guard — a pure classifier over a dangerous-action manifest.
//
// A dangerous mutation must never ship un-gated. This module is the guard the
// conformance gate runs: given a manifest that classifies each dangerous action's
// router tier, it returns the VIOLATIONS — dangerous actions that HAVE a procedure
// but on a non-step-up (plain `protected`) tier. A reserved action with no procedure
// (`none` / absent) is not a violation; a step-up-guarded action is not a violation.
//
// The gate grounds this by ALSO probing the shipped router behaviorally (calling
// each dangerous procedure with no grant must yield STEP_UP_REQUIRED) and asserting
// the manifest matches the wired procedures, so the manifest can never silently
// drift from the router. The mutation twin feeds a dangerous action on the
// `protected` tier and asserts a violation, proving the guard is anti-vacuous.

import {
  DANGEROUS_ACTIONS,
  type DangerousAction,
} from "@perry-starter/auth/step-up";

// How a dangerous action is served by the router:
//   - "step-up": guarded by the step-up gate (the only safe tier for a dangerous op)
//   - "protected": has a procedure on the plain (session-only) tier — a VIOLATION
//   - "none": reserved; no procedure wired yet — not a violation
export type StepUpTier = "step-up" | "protected" | "none";

export type StepUpManifest = Partial<Record<DangerousAction, StepUpTier>>;

// The violations: every dangerous action whose procedure exists on a non-step-up
// tier. Fail-closed by construction — only an explicit "step-up" (or a reserved
// absent/"none") clears an action.
export const findUnguardedDangerousActions = (
  manifest: StepUpManifest
): DangerousAction[] =>
  DANGEROUS_ACTIONS.filter((action) => manifest[action] === "protected");

// The step-up-guarded subset of a manifest (used to assert no drift from the wired
// router procedures).
export const guardedActionsOf = (manifest: StepUpManifest): DangerousAction[] =>
  DANGEROUS_ACTIONS.filter((action) => manifest[action] === "step-up");
