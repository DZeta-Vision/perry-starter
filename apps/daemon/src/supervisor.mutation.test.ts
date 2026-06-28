// Mutation twin for the restart leg: it replicates the restart decision as a
// pure function and feeds it a no-op (never) policy — the supervisor would not
// re-spawn after an unexpected exit, leaving the sidecar dead (so the gate's
// post-exit health-poll would fail). An "always" policy is the green control.

import { describe, expect, test } from "vitest";

type RestartPolicy = "always" | "never";
interface ExitEvent {
  readonly expected: boolean;
}

// The supervisor re-spawns iff the policy says so and the exit was unexpected.
const shouldRespawn = (policy: RestartPolicy, exit: ExitEvent): boolean =>
  policy === "always" && !exit.expected;

const UNEXPECTED_EXIT: ExitEvent = { expected: false };

describe("a no-op restart policy leaves the sidecar dead after an unexpected exit", () => {
  test("the no-op (never) policy does not re-spawn — the gate's post-exit health-poll would fail", () => {
    expect(shouldRespawn("never", UNEXPECTED_EXIT)).toBe(false);
  });

  test("the always policy re-spawns on an unexpected exit (not always-firing)", () => {
    expect(shouldRespawn("always", UNEXPECTED_EXIT)).toBe(true);
  });

  test("an expected (operator stop) exit is never re-spawned", () => {
    expect(shouldRespawn("always", { expected: true })).toBe(false);
  });
});
