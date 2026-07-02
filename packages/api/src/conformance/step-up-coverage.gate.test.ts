// Step-up coverage gate — every dangerous mutation in the shipped router is
// step-up-guarded.
//
// A build-time STRUCTURAL guard (no app boot): it PROBES the shipped router by
// calling each declared dangerous procedure with NO grant and asserting it yields
// STEP_UP_REQUIRED — proving it is genuinely guarded — and asserts the guarded set
// matches the manifest so the manifest can never silently drift from the router. It
// also proves the gate is non-vacuous: with a fresh valid grant the guarded mutation
// actually runs (the gate is not an unconditional throw). The mutation twin
// (step-up-coverage.mutation.test.ts) drives the SAME guard against a dangerous
// action on the plain tier and asserts a violation.

import { DANGEROUS_ACTIONS } from "@perry-starter/auth/step-up";
import { createStepUpGrantStore } from "@perry-starter/auth/step-up-store";
import { TRPCError } from "@trpc/server";
import { expect, test } from "vitest";

import {
  createStepUpCaller,
  STEP_UP_PROCEDURES,
  type StepUpContext,
} from "../index";
import {
  findUnguardedDangerousActions,
  guardedActionsOf,
  type StepUpManifest,
} from "../step-up-registry";

const T0 = 3_000_000;

const probeCtx = (over: Partial<StepUpContext> = {}): StepUpContext => ({
  now: T0,
  recordConsequentAudit: () => undefined,
  recordLockoutFailure: () => undefined,
  recordStepUpAudit: () => undefined,
  revokeSession: () => undefined,
  session: { id: "sess-1", user: { id: "user-1", role: "superadmin" } },
  stepUpStore: createStepUpGrantStore(),
  stepUpToken: undefined,
  ...over,
});

const dataCode = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof TRPCError) {
      const cause = error.cause as { code?: string } | undefined;
      return cause?.code ?? error.code;
    }
  }
  return "no-error";
};

test("the dangerous-action vocabulary is non-empty and includes role change + invitation creation", () => {
  expect(DANGEROUS_ACTIONS.length).toBeGreaterThan(0);
  expect(DANGEROUS_ACTIONS).toContain("role.change");
  expect(DANGEROUS_ACTIONS).toContain("invite.create");
});

// The caller as its finite set of dangerous-procedure names (a Record over a key
// union, so indexing yields a defined callable, not `| undefined`).
type ProcName = keyof typeof STEP_UP_PROCEDURES;
const dangerousProcNames = Object.keys(STEP_UP_PROCEDURES) as ProcName[];
const probeCaller = () =>
  createStepUpCaller(probeCtx()) as unknown as Record<
    ProcName,
    () => Promise<unknown>
  >;

test("every wired dangerous procedure is step-up-guarded (no grant -> STEP_UP_REQUIRED)", async () => {
  for (const procName of dangerousProcNames) {
    const caller = probeCaller();
    expect(await dataCode(() => caller[procName]())).toBe("STEP_UP_REQUIRED");
  }
});

test("the guarded set matches the manifest exactly (no drift between the map and the router)", async () => {
  // Build the manifest from the WIRED procedures + prove each probes as step-up.
  const manifest: StepUpManifest = {};
  for (const procName of dangerousProcNames) {
    const caller = probeCaller();
    const guarded =
      (await dataCode(() => caller[procName]())) === "STEP_UP_REQUIRED";
    manifest[STEP_UP_PROCEDURES[procName]] = guarded ? "step-up" : "protected";
  }
  // No dangerous action is left on a non-step-up tier.
  expect(findUnguardedDangerousActions(manifest)).toEqual([]);
  // The guarded set is exactly the wired subset (role change + invitation creation).
  expect(new Set(guardedActionsOf(manifest))).toEqual(
    new Set(Object.values(STEP_UP_PROCEDURES))
  );
});

test("the gate is non-vacuous: a fresh valid grant lets the guarded mutation run", async () => {
  const store = createStepUpGrantStore();
  const token = store.issue({
    action: "role.change",
    now: T0,
    sessionId: "sess-1",
  });
  const caller = createStepUpCaller(
    probeCtx({ stepUpStore: store, stepUpToken: token })
  );
  await expect(caller.changeRole()).resolves.toEqual({ changed: true });
});
