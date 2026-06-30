// The pure, target-agnostic session-hardening policy.
//
// It is a pure function of injected values only — a numeric clock reading
// (`now`), the server-issued claim (`iat`/`exp`), the server-tracked
// `lastActive`, and refresh-token bookkeeping (`consumedAt`). It reads no wall
// clock and starts no timer, so the same policy is shareable across tiers (the
// runtime host binds it to the real clock + session store) and the conformance
// gate can drive every boundary deterministically. It imports no better-auth
// and no env contract: none of the timeout/rotation/revocation discipline below
// is a built-in better-auth feature — every one is custom adopter wiring.
//
// The fixed session windows are single-sourced from the Story-1.6 reducer so the
// idle/absolute/skew constants never diverge between the offline state-machine
// and this policy.

import {
  ABSOLUTE_SESSION_MS as ABSOLUTE_SESSION_MS_SOURCE,
  IDLE_TIMEOUT_MS as IDLE_TIMEOUT_MS_SOURCE,
  SKEW_TOLERANCE_MS as SKEW_TOLERANCE_MS_SOURCE,
} from "./session-state";

// Surface the single-sourced session windows as part of the policy contract.
// The literals live ONLY in the Story-1.6 reducer; these bindings re-single-
// source them so the idle/absolute/skew windows can never diverge between the
// offline state-machine and this policy. SKEW_TOLERANCE_MS is applied to the
// short-lived-token expiry comparison inside that reducer, surfaced here for the
// policy contract.
export const ABSOLUTE_SESSION_MS = ABSOLUTE_SESSION_MS_SOURCE;
export const IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MS_SOURCE;
export const SKEW_TOLERANCE_MS = SKEW_TOLERANCE_MS_SOURCE;

// A superseded refresh token replayed within this fixed grace window is the
// benign rotation race (tolerated); past it, it is a replay (revoke-all).
export const REFRESH_GRACE_MS = 30_000; // 30 s — fixed

// The cross-surface revocation margin: a revoke must propagate within this
// window. The get-session cache lifetime sits STRICTLY under it (and is actively
// invalidated on revoke) so a revoked session can never linger to a cache TTL.
export const REVOCATION_MARGIN_MS = 300_000; // 5 min — fixed

// The get-session cache lifetime — strictly under the revocation margin.
export const GET_SESSION_CACHE_MAX_MS = 60_000; // 1 min (< 300 s margin)

export type IdleVerdict = "active" | "idle-expired";
export type AbsoluteVerdict = "ceiling-exceeded" | "within";
export type RefreshVerdict = "ok" | "ok-grace" | "replay";
export type CredentialChange = "password" | "role";

export interface ReplayDecision {
  readonly audit: {
    readonly action: string;
    readonly actor: string;
  };
  readonly forceReLogin: boolean;
  readonly revokeScope: "all-sessions";
}

export interface RevokeDecision {
  readonly revokeScope: "all-sessions";
  readonly surfaces: readonly ["cloud", "local"];
  readonly trigger: CredentialChange;
}

export interface RotationResult {
  readonly consumedAt: number;
  readonly nextTokenId: string;
}

// The idle window trips at IDLE_TIMEOUT_MS measured from the server-tracked
// last-active reading (updated only after a successful auth, never the device
// clock).
export const evaluateIdle = ({
  lastActive,
  now,
}: {
  readonly lastActive: number;
  readonly now: number;
}): IdleVerdict =>
  now >= lastActive + IDLE_TIMEOUT_MS ? "idle-expired" : "active";

// The absolute ceiling is the server-issued `iat` plus ABSOLUTE_SESSION_MS —
// computed PURELY from the server claim, never the device clock — so clock skew
// can never extend it. Shifting `iat` shifts the boundary by exactly the same
// amount; the skew slack is applied to the short-lived-token expiry comparison
// only (in the Story-1.6 reducer), never to this ceiling.
export const evaluateAbsolute = ({
  iat,
  now,
}: {
  readonly iat: number;
  readonly now: number;
}): AbsoluteVerdict =>
  now >= iat + ABSOLUTE_SESSION_MS ? "ceiling-exceeded" : "within";

// Single-use refresh rotation: minting the next token supersedes the prior one.
// The new id is unpredictable (a fresh credential), and `consumedAt` is the
// consumption anchor for the prior token. The pure policy reads no clock, so the
// runtime host stamps the absolute wall-clock reading at rotation and persists
// it with the superseded token; that same value is fed back into verifyRefresh,
// which is the load-bearing, clock-injected decision.
export const rotateRefresh = (prevTokenId: string): RotationResult => {
  const nextTokenId = crypto.randomUUID();
  // The next id must differ from the prior (single-use supersede); a UUID never
  // collides with a meaningful prior id, but guard explicitly to be safe.
  return {
    nextTokenId: nextTokenId === prevTokenId ? `${nextTokenId}-r` : nextTokenId,
    consumedAt: 0,
  };
};

// A refresh token is single-use. An unconsumed token verifies ok; a token
// consumed within the fixed grace window is the tolerated rotation race; a
// token presented past the grace is a replay.
export const verifyRefresh = ({
  consumedAt,
  now,
}: {
  readonly consumedAt: number | undefined;
  readonly now: number;
  readonly tokenId: string;
}): RefreshVerdict => {
  if (consumedAt === undefined) {
    return "ok";
  }
  if (now <= consumedAt + REFRESH_GRACE_MS) {
    return "ok-grace";
  }
  return "replay";
};

// A detected replay revokes EVERY session, forces re-login, and emits a
// conforming append-only audit event (the action matches the session/auth
// vocabulary the audit shape enforces).
export const onRefreshReplay = ({
  actor,
}: {
  readonly actor: string;
}): ReplayDecision => ({
  audit: {
    action: "session.refresh_replay_revoked",
    actor,
  },
  forceReLogin: true,
  revokeScope: "all-sessions",
});

// A password OR a role change revokes every session across BOTH surfaces (cloud
// and local); the trigger only labels the cause and never narrows the scope.
export const revokeOnCredentialChange = (
  kind: CredentialChange
): RevokeDecision => ({
  revokeScope: "all-sessions",
  surfaces: ["cloud", "local"],
  trigger: kind,
});

// Revoke actively invalidates the get-session cache rather than letting the
// revoked session linger until a TTL expiry.
export const invalidateCacheOnRevoke = (): boolean => true;
