// The offline session-state consumer — the binding that drives the Story-1.6
// LOCAL_GRACE reducer from the offline ES256 verifier without ever crashing or
// dropping the client to an unauthenticated state.
//
// The offline verifier (createOfflineVerifier) THROWS — rather than returning
// null — on a cold-cache / transport fault: when it has no cached JWKS yet (or a
// `kid` miss) it must (re)fetch the key set, and that fetch can reject while the
// device is offline. A null return means "ran and rejected the token"; a THROW
// means "could not even run the check." Those are different and must be handled
// differently.
//
// This consumer CATCHES that throw and maps it onto the reducer's degraded path:
// while offline that is LOCAL_GRACE (local editing and the offline write queue
// keep working), never SESSION_EXPIRED and never an uncaught exception. The hard
// SESSION_EXPIRED terminal stays reachable ONLY through the reducer's
// online + FAILED-refresh transition — a later connectivity event whose re-auth
// actually fails — exactly as the never-degrade law requires.

import type {
  RefreshOutcome,
  SessionClaims,
  SessionState,
} from "./session-state";
import { evaluateSession } from "./session-state";
import type { OfflineVerifier } from "./verify-es256";

const MS_PER_SECOND = 1000;

export interface OfflineSessionInput {
  // The decoded claim set the reducer evaluates (its `iat`/`exp` are in ms, the
  // reducer's clock unit). The cryptographic verification that produced these
  // claims is owned by the S2 verifier, consumed here, not re-implemented.
  readonly claims: SessionClaims;
  readonly jwt: string;
  // Injected clock reading in MILLISECONDS (the reducer's unit).
  readonly now: number;
  readonly online: boolean;
  // Carried from a connectivity event: the outcome of a re-auth/refresh attempt.
  readonly refreshOutcome?: RefreshOutcome;
  readonly verifier: OfflineVerifier;
}

// Resolve the session state for the (possibly offline) client. The verifier is
// invoked best-effort — opportunistically refreshing the cached JWKS and
// surfacing a tampered/expired token — but its inability to run (the cold-cache
// / transport throw) is caught and degraded to the reducer's offline path rather
// than propagated. The final state is always the reducer's verdict over the
// injected connectivity + refresh facts, so the never-degrade-while-offline law
// holds by construction.
export const resolveOfflineSessionState = async ({
  claims,
  jwt,
  now,
  online,
  refreshOutcome,
  verifier,
}: OfflineSessionInput): Promise<SessionState> => {
  try {
    await verifier.verify(jwt, { now: Math.floor(now / MS_PER_SECOND) });
  } catch {
    // Cold-cache / transport fault: the verifier could not reach the JWKS to
    // (re)fetch the signing keys. Swallow it — never crash, never log out — and
    // fall through to the reducer with the cached claim set.
  }
  return evaluateSession({ claims, now, online, refreshOutcome });
};
