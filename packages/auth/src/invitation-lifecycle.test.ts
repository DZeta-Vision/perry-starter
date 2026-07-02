// Behavior tests for the pure invitation lifecycle: the fail-closed acceptance
// verdict (single-use / revoked / expired / mismatch ordering), the status
// transitions, the no-escalation invitation-role authority (a plain admin invites
// only a member; admin creation is superadmin-only; never a second superadmin), and
// the single-use token (high-entropy mint + deterministic digest, never plaintext).
// Names describe behavior, not a planning id.

import type { Invitation } from "@perry-starter/db/shapes/invitation";
import { expect, test } from "vitest";

import {
  acceptInvitation,
  evaluateInvitationAcceptance,
  evaluateInvitationRole,
  expireInvitation,
  expiresAt,
  INVITATION_TOKEN_ENTROPY_BITS,
  INVITATION_TTL_MS,
  isExpired,
  mintInvitationToken,
  revokeInvitation,
} from "./invitation-lifecycle";
import { hashToken } from "./secret-hash";

const T0 = 5_000_000_000;

const makeInvitation = (over: Partial<Invitation> = {}): Invitation => ({
  accepted_at: null,
  created_at: new Date(T0).toISOString(),
  email: "invitee@example.com",
  expires_at: new Date(expiresAt(T0)).toISOString(),
  invited_by: "user-admin",
  organization_id: null,
  role: "member",
  status: "pending",
  token_hash: "digest-abc",
  ...over,
});

// --- The acceptance verdict (fail-closed, single-use) ------------------------

test("a pending, matching, unexpired invitation accepts", () => {
  expect(
    evaluateInvitationAcceptance({
      invitation: makeInvitation(),
      now: T0 + 1000,
      tokenMatches: true,
    })
  ).toBe("ok");
});

test("a missing invitation is rejected before any field read (not-found)", () => {
  expect(
    evaluateInvitationAcceptance({
      invitation: null,
      now: T0,
      tokenMatches: false,
    })
  ).toBe("not-found");
});

test("a non-matching token is rejected (token-mismatch)", () => {
  expect(
    evaluateInvitationAcceptance({
      invitation: makeInvitation(),
      now: T0,
      tokenMatches: false,
    })
  ).toBe("token-mismatch");
});

test("a revoked invitation is rejected before the expiry read (revoked)", () => {
  expect(
    evaluateInvitationAcceptance({
      invitation: makeInvitation({ status: "revoked" }),
      now: T0,
      tokenMatches: true,
    })
  ).toBe("revoked");
});

test("an already-accepted invitation is a consumed replay (single-use)", () => {
  expect(
    evaluateInvitationAcceptance({
      invitation: makeInvitation({
        accepted_at: new Date(T0).toISOString(),
        status: "accepted",
      }),
      now: T0 + 1,
      tokenMatches: true,
    })
  ).toBe("consumed");
});

test("an invitation past its expiry window is rejected (expired), exact at the boundary", () => {
  const invitation = makeInvitation();
  // At exactly expires_at it is already expired (>=).
  expect(
    evaluateInvitationAcceptance({
      invitation,
      now: expiresAt(T0),
      tokenMatches: true,
    })
  ).toBe("expired");
  // One tick before the boundary it is still ok.
  expect(
    evaluateInvitationAcceptance({
      invitation,
      now: expiresAt(T0) - 1,
      tokenMatches: true,
    })
  ).toBe("ok");
});

test("an expired-status invitation fails closed regardless of the clock", () => {
  expect(
    evaluateInvitationAcceptance({
      invitation: makeInvitation({ status: "expired" }),
      now: T0,
      tokenMatches: true,
    })
  ).toBe("expired");
});

test("isExpired is exact at the boundary", () => {
  const invitation = makeInvitation();
  expect(isExpired(invitation, expiresAt(T0) - 1)).toBe(false);
  expect(isExpired(invitation, expiresAt(T0))).toBe(true);
});

// --- The status transitions ---------------------------------------------------

test("revoke flips status to revoked; a later accept then fails closed", () => {
  const revoked = revokeInvitation(makeInvitation());
  expect(revoked.status).toBe("revoked");
  expect(
    evaluateInvitationAcceptance({
      invitation: revoked,
      now: T0,
      tokenMatches: true,
    })
  ).toBe("revoked");
});

test("expire flips status to expired", () => {
  expect(expireInvitation(makeInvitation()).status).toBe("expired");
});

test("accept stamps accepted_at (single-use) and marks accepted", () => {
  const accepted = acceptInvitation(makeInvitation(), T0 + 42);
  expect(accepted.status).toBe("accepted");
  expect(accepted.accepted_at).toBe(new Date(T0 + 42).toISOString());
  // Re-presenting the now-accepted invitation resolves to consumed.
  expect(
    evaluateInvitationAcceptance({
      invitation: accepted,
      now: T0 + 100,
      tokenMatches: true,
    })
  ).toBe("consumed");
});

// --- The no-escalation invitation-role authority (c4) ------------------------

test("a plain admin may invite only a member", () => {
  expect(
    evaluateInvitationRole({ inviterRole: "admin", requestedRole: "member" })
  ).toBe("ok");
  expect(
    evaluateInvitationRole({ inviterRole: "admin", requestedRole: "admin" })
  ).toBe("forbidden-escalation");
  expect(
    evaluateInvitationRole({
      inviterRole: "admin",
      requestedRole: "superadmin",
    })
  ).toBe("forbidden-escalation");
});

test("admin creation is superadmin-only; a superadmin is never mintable via an invitation", () => {
  expect(
    evaluateInvitationRole({
      inviterRole: "superadmin",
      requestedRole: "member",
    })
  ).toBe("ok");
  expect(
    evaluateInvitationRole({
      inviterRole: "superadmin",
      requestedRole: "admin",
    })
  ).toBe("ok");
  // Never a second superadmin.
  expect(
    evaluateInvitationRole({
      inviterRole: "superadmin",
      requestedRole: "superadmin",
    })
  ).toBe("forbidden-escalation");
});

test("a below-admin caller cannot invite at all", () => {
  expect(
    evaluateInvitationRole({ inviterRole: "member", requestedRole: "member" })
  ).toBe("forbidden-not-admin");
});

test("an out-of-vocabulary requested role is rejected", () => {
  expect(
    evaluateInvitationRole({
      inviterRole: "superadmin",
      requestedRole: "owner",
    })
  ).toBe("invalid-role");
});

test("a multi-role claim keys on the highest tier (admin,member invites a member)", () => {
  expect(
    evaluateInvitationRole({
      inviterRole: "admin,member",
      requestedRole: "member",
    })
  ).toBe("ok");
  expect(
    evaluateInvitationRole({
      inviterRole: "admin,member",
      requestedRole: "admin",
    })
  ).toBe("forbidden-escalation");
});

// --- The single-use token (high-entropy mint + deterministic digest) ---------

test("the token TTL is a positive window and the entropy is >=256 bits", () => {
  expect(INVITATION_TTL_MS).toBeGreaterThan(0);
  expect(INVITATION_TOKEN_ENTROPY_BITS).toBeGreaterThanOrEqual(256);
});

test("minted tokens are unpredictable (two mints differ)", () => {
  expect(mintInvitationToken()).not.toBe(mintInvitationToken());
});

test("the token digest is deterministic and never the plaintext token", async () => {
  const token = mintInvitationToken();
  const digestA = await hashToken(token);
  const digestB = await hashToken(token);
  expect(digestA).toBe(digestB);
  expect(digestA).not.toBe(token);
  // A different token yields a different digest.
  expect(await hashToken(mintInvitationToken())).not.toBe(digestA);
});
