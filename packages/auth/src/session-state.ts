// The pure, target-agnostic offline session-state reducer.
//
// It is a pure function of injected inputs only: a numeric clock reading (`now`)
// and a connectivity boolean (`online`) are parameters, never read from the
// ambient wall clock, the connectivity API, or timers. That keeps the module
// shareable across tiers — the runtime host binds it to the real clock and
// connectivity/refresh path, while the UI reflects its verdict — and lets the
// conformance gate drive every state deterministically.
//
// The law it encodes: the client never degrades to an unauthenticated state
// while offline. Going offline before the cached token expires keeps the session
// operational; when the short-lived token expires WHILE offline the client
// enters a degraded grace state (LOCAL_GRACE) — local editing and the offline
// write queue keep working — rather than logging the user out. The hard expiry
// fires only on a later connectivity event whose re-auth/refresh actually fails.
//
// This module decodes nothing and verifies nothing: it consumes an
// already-decoded claim set and emits a state transition. The cryptographic
// verification of the token, the real refresh/revocation revalidation, and the
// error-envelope routing of the expired terminal are each owned elsewhere.

// Fixed session windows. SKEW_TOLERANCE_MS is a small fixed slack applied ONLY
// to the short-lived-token expiry comparison; it is bounded by the idle window
// and is never derived from a device clock nor configured per request.
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const SKEW_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes (fixed, ≤ idle)
export const ABSOLUTE_SESSION_MS = 8 * 60 * 60 * 1000; // 8 hours

export type SessionState = "AUTHENTICATED" | "LOCAL_GRACE" | "SESSION_EXPIRED";

// The decoded claim set the reducer consumes. The cryptographic verification of
// the token that produced these claims is owned elsewhere; this module trusts
// the decoded values and reads no device clock.
export interface SessionClaims {
  readonly exp: number;
  readonly iat: number;
  readonly scope_user_id: string;
}

// A connectivity event may carry the outcome of a re-auth/refresh attempt.
export type RefreshOutcome = "failed" | "ok";

export interface EvaluateSessionInput {
  readonly claims: SessionClaims;
  readonly now: number;
  readonly online: boolean;
  readonly refreshOutcome?: RefreshOutcome;
}

// The absolute ceiling is derived purely from the server-issued claim — never a
// device-clock term — so clock skew can never extend the session past it.
const ceilingFor = (claims: SessionClaims): number =>
  claims.iat + ABSOLUTE_SESSION_MS;

export const evaluateSession = ({
  claims,
  now,
  online,
  refreshOutcome,
}: EvaluateSessionInput): SessionState => {
  // A connectivity event carrying a definite re-auth/refresh result is the ONLY
  // path to the hard expiry: a failed refresh ends the session, a successful one
  // restores it.
  if (online) {
    if (refreshOutcome === "failed") {
      return "SESSION_EXPIRED";
    }
    if (refreshOutcome === "ok") {
      return "AUTHENTICATED";
    }
  }

  // Offline (or online awaiting a refresh result): never a hard logout. Past the
  // absolute ceiling the session stays operational offline — the ceiling is
  // enforced at the next connectivity event (whose refresh fails), never by an
  // offline degrade — so the data path is never blocked while disconnected.
  if (now >= ceilingFor(claims)) {
    return "AUTHENTICATED";
  }

  // Within the absolute ceiling: once the short-lived token expires (plus the
  // fixed skew slack, applied to THIS comparison only) the client drops into the
  // degraded grace state instead of logging out.
  if (now > claims.exp + SKEW_TOLERANCE_MS) {
    return "LOCAL_GRACE";
  }

  return "AUTHENTICATED";
};

// The data path is open for the operational and grace states and closed only
// once the session has hard-expired; it is never blocked merely for being
// offline.
export const guardDataAccess = (state: SessionState): "allow" | "block" =>
  state === "SESSION_EXPIRED" ? "block" : "allow";

// Enqueuing offline work follows the same rule as data access.
export const canEnqueue = (state: SessionState): boolean =>
  guardDataAccess(state) === "allow";

// Past the absolute ceiling, a reconnect MUST force a token refresh before the
// session may be trusted: the cached token is beyond its server-issued lifetime,
// so an online client may not keep operating on it. Offline past-ceiling stays
// operational (never-degrade); the obligation fires the instant connectivity
// returns and no refresh result has yet been applied.
export const mustForceRefresh = ({
  claims,
  now,
  online,
  refreshOutcome,
}: EvaluateSessionInput): boolean =>
  online && refreshOutcome === undefined && now >= ceilingFor(claims);
