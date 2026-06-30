// The single revocation-discovery flush-gate — the ONE authority that decides
// whether queued offline work flushes, holds, or is quarantined on reconnect.
//
// It upgrades the earlier default-safe always-HOLD stub into a live gate and is
// the sole owner of the "is the revocation outcome revoked → what do we do"
// decision. The earlier dual surfaces (the offline-queue gate and the
// session-state reducer) now route every revocation decision through here
// rather than re-deriving it, so the decision is single at rest AND single at
// source.
//
// It is a PURE function of injected inputs only — connectivity, whether the
// session has been revalidated against the cloud authority, the revocation
// outcome, and the elapsed time since reconnect. It reads no wall clock, opens
// no socket, and starts no timer; the runtime host (the daemon reconnect
// heartbeat) binds it to the real revalidation call within the SLA.
//
// The law it encodes:
//   - Never flush while offline.
//   - Revalidate BEFORE any flush: an un-revalidated online session never
//     flushes, no matter how long it has been waiting.
//   - A session revoked while offline is QUARANTINED on reconnect — the queue is
//     held intact (neither merged nor discarded), each item's stamped owning
//     subject preserved — never flushed.
//   - A revalidated, AFFIRMATIVELY-VALID session releases for flush; the absence
//     of an outcome (revalidated but no verdict yet) HOLDS — flush never opens on
//     the absence of a verdict (fail closed).
//   - The revocation SLA is live: revalidation is expected within the target
//     window and MUST land before the hard ceiling; past the hard ceiling with
//     no successful revalidation the queue is quarantined rather than left in an
//     unbounded, untrustworthy hold.

export type FlushDecision = "flush" | "hold" | "quarantine";

export type RevocationOutcome = "revoked" | "valid";

export interface DecideFlushInput {
  readonly online: boolean;
  readonly revalidated: boolean;
  readonly revocationOutcome?: RevocationOutcome;
  readonly sinceReconnectMs?: number;
}

// The revocation SLA: revalidation is expected to complete within the target
// window (5 min) and MUST complete before the hard ceiling (10 min). The daemon
// reconnect heartbeat schedules the real revalidation against these bounds; they
// are single-sourced here so the gate and the heartbeat never diverge.
export const REVOCATION_SLA_MS = 300_000; // 5 min — revalidation target
export const REVOCATION_SLA_MAX_MS = 600_000; // 10 min — hard ceiling

export const decideFlush = ({
  online,
  revalidated,
  revocationOutcome,
  sinceReconnectMs,
}: DecideFlushInput): FlushDecision => {
  // Never flush while offline.
  if (!online) {
    return "hold";
  }

  // Revalidate BEFORE any flush. Until the session is revalidated against the
  // authority the queue holds — and once the hard SLA ceiling passes with no
  // successful revalidation the session can no longer be trusted to be unrevoked,
  // so the queue is quarantined rather than left in an unbounded hold. A flush
  // is unreachable on un-revalidated state regardless of elapsed time.
  if (!revalidated) {
    const elapsed = sinceReconnectMs ?? 0;
    if (elapsed > REVOCATION_SLA_MAX_MS) {
      return "quarantine";
    }
    return "hold";
  }

  // Revalidated: a session revoked while offline is quarantined (queue held
  // intact, never flushed); an affirmatively-valid session releases for flush.
  if (revocationOutcome === "revoked") {
    return "quarantine";
  }
  if (revocationOutcome === "valid") {
    return "flush";
  }
  // revalidated flag set but no affirmative outcome yet -> fail closed: hold and
  // retry, never flush an unproven session on the absence of a verdict.
  return "hold";
};
