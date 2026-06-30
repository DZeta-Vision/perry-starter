import { describe, expect, test } from "vitest";

// Anti-vacuous twin for the live flush-gate. The gate's behavioral checkers are
// replicated here and run against deliberately-wrong, self-contained inline
// gates (no import of the real module), proving each invariant goes RED on a
// bad gate and GREEN on a correct control.
//
// RED PHASE: every test is `test.skip` to match the gate's red phase; the
// fixtures are self-contained so collection never throws.

const FIVE_MIN_MS = 300_000;
const TEN_MIN_MS = 600_000;

type FlushDecision = "flush" | "hold" | "quarantine";
type RevocationOutcome = "revoked" | "valid";

interface DecideInput {
  readonly online: boolean;
  readonly revalidated: boolean;
  readonly revocationOutcome?: RevocationOutcome;
  readonly sinceReconnectMs?: number;
}

interface FlushGateModule {
  readonly decideFlush: (input: DecideInput) => FlushDecision;
  readonly REVOCATION_SLA_MAX_MS: number;
  readonly REVOCATION_SLA_MS: number;
}

// --- Replicated checkers (verbatim with the gate) ----------------------------

const offlineNeverFlushViolations = (m: FlushGateModule): string[] => {
  const violations: string[] = [];
  if (m.decideFlush({ online: false, revalidated: false }) === "flush") {
    violations.push("an offline client must never flush");
  }
  return violations;
};

const revalidateBeforeFlushViolations = (m: FlushGateModule): string[] => {
  const violations: string[] = [];
  if (
    m.decideFlush({ online: true, revalidated: false, sinceReconnectMs: 0 }) ===
    "flush"
  ) {
    violations.push("a flush must not happen before revalidation");
  }
  if (
    m.decideFlush({
      online: true,
      revalidated: false,
      sinceReconnectMs: m.REVOCATION_SLA_MAX_MS + 1,
    }) === "flush"
  ) {
    violations.push(
      "a flush must not open on stale, un-revalidated state past the SLA"
    );
  }
  return violations;
};

const revalidatedOutcomeViolations = (m: FlushGateModule): string[] => {
  const violations: string[] = [];
  if (
    m.decideFlush({
      online: true,
      revalidated: true,
      revocationOutcome: "revoked",
      sinceReconnectMs: 1000,
    }) !== "quarantine"
  ) {
    violations.push("a session revoked while offline must be quarantined");
  }
  if (
    m.decideFlush({
      online: true,
      revalidated: true,
      revocationOutcome: "valid",
      sinceReconnectMs: 1000,
    }) !== "flush"
  ) {
    violations.push("a revalidated, still-valid session must flush");
  }
  return violations;
};

// --- Controls + deliberately-wrong fixtures ----------------------------------

const correct: FlushGateModule = {
  REVOCATION_SLA_MS: FIVE_MIN_MS,
  REVOCATION_SLA_MAX_MS: TEN_MIN_MS,
  decideFlush: ({ online, revalidated, revocationOutcome }) => {
    if (!online) {
      return "hold";
    }
    if (!revalidated) {
      return "hold";
    }
    if (revocationOutcome === "revoked") {
      return "quarantine";
    }
    return "flush";
  },
};

// Flushes while offline.
const flushesOffline: FlushGateModule = {
  ...correct,
  decideFlush: () => "flush",
};

// Flushes before the session is revalidated.
const flushesBeforeRevalidation: FlushGateModule = {
  ...correct,
  decideFlush: ({ online }) => (online ? "flush" : "hold"),
};

// Flushes a session that was revoked while offline (instead of quarantining).
const flushesRevoked: FlushGateModule = {
  ...correct,
  decideFlush: ({ online, revalidated }) => {
    if (!(online && revalidated)) {
      return "hold";
    }
    return "flush";
  },
};

describe("the flush-gate twin rejects gates that flush unsafely", () => {
  test("a gate that flushes while offline reddens", () => {
    expect(offlineNeverFlushViolations(correct)).toEqual([]);
    expect(offlineNeverFlushViolations(flushesOffline).length).toBeGreaterThan(
      0
    );
  });

  test("a gate that flushes before revalidation reddens", () => {
    expect(revalidateBeforeFlushViolations(correct)).toEqual([]);
    expect(
      revalidateBeforeFlushViolations(flushesBeforeRevalidation).length
    ).toBeGreaterThan(0);
  });

  test("a gate that flushes a session revoked while offline reddens", () => {
    expect(revalidatedOutcomeViolations(correct)).toEqual([]);
    expect(revalidatedOutcomeViolations(flushesRevoked).length).toBeGreaterThan(
      0
    );
  });
});
