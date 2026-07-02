// The pending-invitation lifecycle — PURE, target-agnostic policy over injected
// inputs (an invitation row, an injected clock reading, and a token-match boolean).
//
// This module is the single source of the invitation SECURITY PROPERTIES: the
// token is single-use, time-limited, and matched by digest; acceptance fails
// closed on any non-pending / expired / mismatched state; and the role an
// invitation may stamp is bounded by the no-escalation hierarchy. It reads no wall
// clock and holds no state (the privileged forwarder owns persistence), so the same
// policy is shareable across tiers and the conformance tests can drive every
// boundary deterministically. The account is provisioned ONLY on the `ok` verdict —
// never at invite time — so no half-formed privileged account exists before
// acceptance.

import {
  APP_ROLE_RANK,
  appRoleSchema,
} from "@perry-starter/db/shapes/identity";
import type { Invitation } from "@perry-starter/db/shapes/invitation";
import { holdsAdminSurface, resolveGlobalRoles } from "./rbac";
import { randomToken } from "./secret-hash";

// The invitation TTL: 48h from minting. The single-use + fail-closed properties are
// asserted independent of this literal, so a later artifact override is a constant
// swap.
export const INVITATION_TTL_MS = 48 * 60 * 60 * 1000;

// The token entropy: 32 random bytes (≥256 bits). The sole entropy source is
// `crypto.getRandomValues` (via `randomToken`) — never `Math.random`. The plaintext
// token is handed to the invitee (in the email) exactly once; only its digest is
// persisted.
const INVITATION_TOKEN_ENTROPY_BYTES = 32;
export const INVITATION_TOKEN_ENTROPY_BITS = INVITATION_TOKEN_ENTROPY_BYTES * 8;

// Mint a fresh single-use invitation token. Unpredictable and meaningless without
// the persisted digest, so a client can never fabricate a valid one.
export const mintInvitationToken = (): string =>
  randomToken(INVITATION_TOKEN_ENTROPY_BYTES);

// The expiry instant for an invitation minted at `now`.
export const expiresAt = (now: number): number => now + INVITATION_TTL_MS;

// Whether an invitation is past its expiry window at `now`. Exact at the boundary:
// an invitation is expired once `now` reaches `expires_at`.
export const isExpired = (invitation: Invitation, now: number): boolean =>
  now >= Date.parse(invitation.expires_at);

// --- The acceptance verdict (fail-closed, single-use) ------------------------

// Every non-`ok` verdict is a rejection that MUST NOT provision an account.
export type InvitationAcceptanceVerdict =
  | "ok"
  | "not-found"
  | "token-mismatch"
  | "revoked"
  | "consumed"
  | "expired";

// The pure acceptance decision. Order is deliberate and fail-closed:
//   1. a missing invitation is rejected before any field read (not-found),
//   2. a digest that does not match is rejected (token-mismatch),
//   3. a revoked invitation is rejected before the expiry read (revoked),
//   4. an already-accepted invitation (accepted_at set, or status accepted) is a
//      replay of a spent token (consumed) — single-use,
//   5. an expired-status OR past-window invitation is rejected (expired),
//   6. any remaining non-pending state fails closed (expired),
//   7. only a pending, matching, unexpired invitation is `ok`.
export const evaluateInvitationAcceptance = (input: {
  readonly invitation: Invitation | null | undefined;
  readonly tokenMatches: boolean;
  readonly now: number;
}): InvitationAcceptanceVerdict => {
  const { invitation, tokenMatches, now } = input;
  if (!invitation) {
    return "not-found";
  }
  if (!tokenMatches) {
    return "token-mismatch";
  }
  if (invitation.status === "revoked") {
    return "revoked";
  }
  if (invitation.status === "accepted" || invitation.accepted_at !== null) {
    return "consumed";
  }
  if (invitation.status === "expired" || isExpired(invitation, now)) {
    return "expired";
  }
  if (invitation.status !== "pending") {
    return "expired";
  }
  return "ok";
};

// --- The pure status transitions ----------------------------------------------

// Revoke a pending invitation — invalidates the token (a later accept resolves to
// `revoked`). Idempotent-safe: revoking a terminal invitation keeps it terminal.
export const revokeInvitation = (invitation: Invitation): Invitation => ({
  ...invitation,
  status: "revoked",
});

// Auto-expire a pending invitation past its window — the sweep transition.
export const expireInvitation = (invitation: Invitation): Invitation => ({
  ...invitation,
  status: "expired",
});

// Accept a pending invitation — single-use: stamps `accepted_at` so a replay
// resolves to `consumed`.
export const acceptInvitation = (
  invitation: Invitation,
  now: number
): Invitation => ({
  ...invitation,
  status: "accepted",
  accepted_at: new Date(now).toISOString(),
});

// --- The no-escalation invitation-role authority (c4) ------------------------

// Every non-`ok` verdict is a rejection that MUST NOT persist an invitation.
export type InvitationRoleVerdict =
  | "ok"
  | "invalid-role"
  | "forbidden-not-admin"
  | "forbidden-escalation";

type Tier = "member" | "admin" | "superadmin";

// The highest GLOBAL tier a comma-split role claim resolves to (defaults to the
// lowest). Keyed on the actor's HIGHEST tier so a multi-role claim cannot dodge the
// hierarchy — the same posture the role-assignment authority uses.
const highestGlobalTier = (roleClaim: string): Tier => {
  let best: Tier = "member";
  for (const tier of resolveGlobalRoles({ user: { role: roleClaim } })) {
    if (
      (tier === "member" || tier === "admin" || tier === "superadmin") &&
      APP_ROLE_RANK[tier] > APP_ROLE_RANK[best]
    ) {
      best = tier;
    }
  }
  return best;
};

// The pure invitation-role decision — the server authority for which role an
// invitation may stamp, regardless of client state. It reuses the numeric-hierarchy
// no-escalation posture of the role-assignment authority: an invitation may stamp
// only a role STRICTLY BELOW the inviter's own tier. Order is deliberate:
//   1. an out-of-vocabulary requested role is rejected (invalid-role),
//   2. a below-admin caller cannot invite at all (forbidden-not-admin),
//   3. the requested tier must be strictly below the inviter's tier
//      (forbidden-escalation) — so a plain admin may invite only a member, admin
//      creation is superadmin-only, and a superadmin is never mintable (never a
//      second superadmin via an invitation).
export const evaluateInvitationRole = (input: {
  readonly inviterRole: string;
  readonly requestedRole: string;
}): InvitationRoleVerdict => {
  const parsed = appRoleSchema.safeParse(input.requestedRole);
  if (!parsed.success) {
    return "invalid-role";
  }
  if (!holdsAdminSurface(input.inviterRole)) {
    return "forbidden-not-admin";
  }
  const inviterTier = highestGlobalTier(input.inviterRole);
  if (APP_ROLE_RANK[parsed.data] >= APP_ROLE_RANK[inviterTier]) {
    return "forbidden-escalation";
  }
  return "ok";
};
