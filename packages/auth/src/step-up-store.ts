// The server-side step-up grant store — where single-use + server-verification
// live.
//
// The pure policy (`./step-up`) decides the verdict; this store holds the minted
// grants and performs the ATOMIC verify-and-consume so a grant can be spent exactly
// once. Because the store — not the client — mints the opaque token and owns
// consumption, a client can NEVER satisfy step-up by asserting success: a token the
// store never issued resolves to `missing`, and a spent token resolves to
// `consumed`. It also counts per-(session, action) failures so the gate can abort
// the ACTION (never the session) after the fail-twice ceiling.
//
// This reference store is in-memory (the P0 security properties are a property of
// the verify-and-consume logic, not the backing store); the cloud tier binds a
// durable-backed store implementing the same interface. Spike-gated: the real
// re-auth credential that mints a grant is injected by the caller.

import {
  type DangerousAction,
  evaluateStepUpFailure,
  mintStepUpGrant,
  type StepUpGrant,
  type StepUpVerdict,
  verifyStepUpGrant,
} from "./step-up";

// The result of an atomic verify-and-consume. `granted` gates the mutation;
// `aborted` (only ever true on a rejection) signals the fail-twice ceiling was hit
// so the caller aborts the ACTION — the session is never in scope here.
export interface StepUpConsumeResult {
  readonly aborted: boolean;
  readonly failureCount: number;
  readonly granted: boolean;
  readonly verdict: StepUpVerdict;
}

export interface StepUpGrantStore {
  // Mint + persist a fresh grant for one (session, action); returns the opaque token.
  readonly issue: (input: {
    readonly sessionId: string;
    readonly action: DangerousAction;
    readonly now: number;
  }) => string;
  // Atomically verify the presented token against (session, action, now) and, on
  // success, mark it consumed (single-use). On failure, count the attempt.
  readonly verifyAndConsume: (input: {
    readonly token: string | undefined;
    readonly sessionId: string;
    readonly action: DangerousAction;
    readonly now: number;
  }) => StepUpConsumeResult;
}

const failureKey = (sessionId: string, action: DangerousAction): string =>
  `${sessionId}::${action}`;

export const createStepUpGrantStore = (): StepUpGrantStore => {
  const grants = new Map<string, StepUpGrant>();
  const failures = new Map<string, number>();

  const issue: StepUpGrantStore["issue"] = ({ sessionId, action, now }) => {
    const grant = mintStepUpGrant({ sessionId, action, now });
    grants.set(grant.id, grant);
    return grant.id;
  };

  const verifyAndConsume: StepUpGrantStore["verifyAndConsume"] = ({
    token,
    sessionId,
    action,
    now,
  }) => {
    const grant = token === undefined ? undefined : grants.get(token);
    const verdict = verifyStepUpGrant({ grant, sessionId, action, now });

    if (verdict === "ok" && grant) {
      // Single-use: mark consumed so this token can never be re-spent. Persist the
      // consumed grant so a replay resolves to `consumed`, not `missing`.
      grants.set(grant.id, { ...grant, consumedAt: now });
      // A success clears the (session, action) failure tally.
      failures.delete(failureKey(sessionId, action));
      return { granted: true, verdict, aborted: false, failureCount: 0 };
    }

    // A rejection: count the failed attempt for this (session, action) and decide
    // whether the fail-twice ceiling aborts the action. The session is never scoped.
    const key = failureKey(sessionId, action);
    const failureCount = (failures.get(key) ?? 0) + 1;
    failures.set(key, failureCount);
    const aborted = evaluateStepUpFailure({ failureCount }) === "abort-action";
    return { granted: false, verdict, aborted, failureCount };
  };

  return { issue, verifyAndConsume };
};
