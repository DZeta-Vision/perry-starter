// Step-up coverage gate for the invitation router — every token-issuing invitation
// mutation (create + resend) is step-up-guarded.
//
// A build-time STRUCTURAL guard: it PROBES the shipped invitation router by calling
// each declared dangerous procedure with NO grant and asserting it yields
// STEP_UP_REQUIRED — proving it is genuinely guarded — and asserts no wired
// invitation dangerous action is left on a non-step-up tier. It also proves the gate
// is non-vacuous: with a fresh valid grant the guarded mutation actually runs. The
// mutation twin (invitation-step-up.mutation.test.ts) drives the SAME pure guard
// against the invitation dangerous action on the plain tier and asserts a violation.

import { createStepUpGrantStore } from "@perry-starter/auth/step-up-store";
import type { Invitation } from "@perry-starter/db/shapes/invitation";
import { TRPCError } from "@trpc/server";
import { expect, test } from "vitest";
import { INVITATION_SURFACE_RESPONSE } from "../invitation-surface";
import {
  createInvitationCaller,
  INVITATION_STEP_UP_PROCEDURES,
  type InvitationContext,
} from "../invitations";
import { findUnguardedDangerousActions } from "../step-up-registry";

const T0 = 7_500_000;

const probeCtx = (
  over: Partial<InvitationContext> = {}
): InvitationContext => ({
  loadInvitationByTokenHash: (): Invitation | null => null,
  markInvitationAccepted: () => undefined,
  now: T0,
  persistInvitation: () => undefined,
  provisionInvitedAccount: () => ({ userId: "user-new" }),
  recordConsequentAudit: () => undefined,
  recordLockoutFailure: () => undefined,
  recordStepUpAudit: () => undefined,
  revokePriorInvitations: () => undefined,
  revokeSession: () => undefined,
  sendInvitationEmail: () => undefined,
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

type ProcName = keyof typeof INVITATION_STEP_UP_PROCEDURES;
const dangerousProcNames = Object.keys(
  INVITATION_STEP_UP_PROCEDURES
) as ProcName[];

const probeCaller = () =>
  createInvitationCaller(probeCtx()) as unknown as Record<
    ProcName,
    () => Promise<unknown>
  >;

test("the invitation dangerous-action set covers create and resend under invite.create", () => {
  expect(Object.values(INVITATION_STEP_UP_PROCEDURES)).toContain(
    "invite.create"
  );
  expect(dangerousProcNames).toContain("createInvitation");
  expect(dangerousProcNames).toContain("resendInvitation");
});

test("every wired invitation dangerous procedure is step-up-guarded (no grant -> STEP_UP_REQUIRED)", async () => {
  for (const procName of dangerousProcNames) {
    const caller = probeCaller();
    expect(await dataCode(() => caller[procName]())).toBe("STEP_UP_REQUIRED");
  }
});

test("no wired invitation dangerous action is left on a non-step-up tier", async () => {
  const manifest: Record<string, "step-up" | "protected"> = {};
  for (const procName of dangerousProcNames) {
    const caller = probeCaller();
    const guarded =
      (await dataCode(() => caller[procName]())) === "STEP_UP_REQUIRED";
    manifest[INVITATION_STEP_UP_PROCEDURES[procName]] = guarded
      ? "step-up"
      : "protected";
  }
  expect(findUnguardedDangerousActions(manifest)).toEqual([]);
});

test("the gate is non-vacuous: a fresh valid grant lets the guarded create run", async () => {
  const store = createStepUpGrantStore();
  const token = store.issue({
    action: "invite.create",
    now: T0,
    sessionId: "sess-1",
  });
  const caller = createInvitationCaller(
    probeCtx({ stepUpStore: store, stepUpToken: token })
  );
  await expect(
    caller.createInvitation({ email: "invitee@example.com", role: "member" })
  ).resolves.toEqual(INVITATION_SURFACE_RESPONSE);
});
