// Conformance gate — cross-surface response invariance (anti-enumeration) over the
// INVITATION surfaces.
//
// The invitation create / resend / accept surfaces must never reveal whether the
// target email is already a registered/verified account or is unknown: every surface
// returns the ONE canonical neutral envelope, byte-identical across the five-state
// email matrix. This gate drives the REAL invitation router surfaces across the
// matrix and asserts (a) each response is byte-identical to `neutralAuthEnvelope`
// single-sourced in packages/db, (b) none leaks an existence/state token, and (c) the
// single neutral surface is the SAME envelope the other pre-auth surfaces serve —
// reusing the SAME cross-surface detectors the sign-up / verification-resend /
// password-reset gate uses (`@perry-starter/auth/conformance/response-invariance`),
// so this is one cross-surface invariant, not a per-surface replica. Its paired
// `*.mutation.test.ts` twin proves the SAME checker reddens on a revealing surface.

import {
  allByteIdentical,
  canonicalize,
  EMAIL_MATRIX,
  revealsExistenceOrState,
  type SurfaceResponse,
} from "@perry-starter/auth/conformance/response-invariance";
import { createStepUpGrantStore } from "@perry-starter/auth/step-up-store";
import { neutralAuthEnvelope } from "@perry-starter/db/auth/neutral-response";
import type { Invitation } from "@perry-starter/db/shapes/invitation";
import { expect, test } from "vitest";
import {
  INVITATION_SURFACE_RESPONSE,
  type InvitationOutcome,
  invitationSurfaceResponse,
} from "../invitation-surface";
import { createInvitationCaller, type InvitationContext } from "../invitations";

const T0 = 8_000_000;

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

// Drive the REAL create surface for one email (a fresh step-up grant per call).
const createResponse = async (email: string): Promise<SurfaceResponse> => {
  const store = createStepUpGrantStore();
  const token = store.issue({
    action: "invite.create",
    now: T0,
    sessionId: "sess-1",
  });
  const caller = createInvitationCaller(
    probeCtx({ stepUpStore: store, stepUpToken: token })
  );
  return (await caller.createInvitation({
    email,
    role: "member",
  })) as SurfaceResponse;
};

// Drive the REAL accept surface for one token (public, sessionless).
const acceptResponse = async (token: string): Promise<SurfaceResponse> => {
  const caller = createInvitationCaller(probeCtx({ session: null }));
  return (await caller.acceptInvitation({ token })) as SurfaceResponse;
};

const ALL_OUTCOMES: readonly InvitationOutcome[] = [
  "created",
  "account-exists",
  "resent",
  "accepted",
  "rejected",
];

test("every internal outcome maps to the ONE neutral envelope (single-return, never branches)", () => {
  const responses = ALL_OUTCOMES.map((outcome) =>
    invitationSurfaceResponse(outcome)
  );
  expect(allByteIdentical(responses)).toBe(true);
  for (const response of responses) {
    expect(response.status).toBe(neutralAuthEnvelope.status);
    expect(response.body).toEqual(neutralAuthEnvelope.body);
  }
});

test("the invitation neutral surface is byte-identical to the canonical pre-auth envelope (cross-surface)", () => {
  expect(canonicalize(INVITATION_SURFACE_RESPONSE)).toBe(
    canonicalize({
      body: neutralAuthEnvelope.body,
      headers: neutralAuthEnvelope.headers,
      status: neutralAuthEnvelope.status,
    })
  );
});

test("create and accept are byte-identical across the five-state email matrix and leak no existence token", async () => {
  const responses: SurfaceResponse[] = [];
  for (const state of EMAIL_MATRIX) {
    const email = `${state}@matrix.example.com`;
    const created = await createResponse(email);
    const accepted = await acceptResponse(`${state}-token`);
    // Each surface carries the neutral envelope's status + body regardless of state.
    expect(created.status).toBe(neutralAuthEnvelope.status);
    expect(created.body).toEqual(neutralAuthEnvelope.body);
    expect(accepted.body).toEqual(neutralAuthEnvelope.body);
    // Neither echoes the submitted email nor an existence/state token.
    expect(revealsExistenceOrState(created.body)).toBe(false);
    expect(revealsExistenceOrState(accepted.body)).toBe(false);
    expect(JSON.stringify(created.body).includes(email)).toBe(false);
    responses.push(created, accepted);
  }
  expect(allByteIdentical(responses)).toBe(true);
});

test("EMAIL_NOT_VERIFIED is unreachable on the invitation surfaces", () => {
  expect(revealsExistenceOrState(INVITATION_SURFACE_RESPONSE.body)).toBe(false);
  expect(
    JSON.stringify(INVITATION_SURFACE_RESPONSE)
      .toUpperCase()
      .includes("EMAIL_NOT_VERIFIED")
  ).toBe(false);
});
