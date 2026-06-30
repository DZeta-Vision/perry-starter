import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Conformance gate for the LIVE revocation-discovery flush-gate — the single
// authority that decides whether queued offline work flushes, holds, or is
// quarantined on reconnect. It upgrades the earlier default-safe always-HOLD
// stub and collapses the earlier dual decision surface into ONE module.
//
// The gate is a PURE function of injected inputs: connectivity, whether the
// session has been revalidated against the authority, the revocation outcome,
// and the elapsed time since reconnect. No wall clock, no network, no timers.

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/data/src
const GATE_FILE = resolve(HERE, "flush-gate.ts");
const OUTBOX_FILE = resolve(HERE, "outbox.ts");
const SESSION_STATE_FILE = resolve(
  HERE,
  "..",
  "..",
  "auth",
  "src",
  "session-state.ts"
);

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

// --- Behavioral checkers (replicated verbatim in the mutation twin) ----------

// Never flush while offline.
const offlineNeverFlushViolations = (m: FlushGateModule): string[] => {
  const violations: string[] = [];
  const decision = m.decideFlush({ online: false, revalidated: false });
  if (decision === "flush") {
    violations.push("an offline client must never flush");
  }
  return violations;
};

// A reconnected client must revalidate the session BEFORE any flush: an
// un-revalidated online state never flushes, regardless of elapsed time.
const revalidateBeforeFlushViolations = (m: FlushGateModule): string[] => {
  const violations: string[] = [];
  const fresh = m.decideFlush({
    online: true,
    revalidated: false,
    sinceReconnectMs: 0,
  });
  if (fresh === "flush") {
    violations.push("a flush must not happen before revalidation");
  }
  const stale = m.decideFlush({
    online: true,
    revalidated: false,
    sinceReconnectMs: m.REVOCATION_SLA_MAX_MS + 1,
  });
  if (stale === "flush") {
    violations.push(
      "a flush must not open on stale, un-revalidated state past the SLA"
    );
  }
  return violations;
};

// A session revoked while offline is quarantined, not flushed; a still-valid
// revalidated session is released for flush.
const revalidatedOutcomeViolations = (m: FlushGateModule): string[] => {
  const violations: string[] = [];
  const valid = m.decideFlush({
    online: true,
    revalidated: true,
    revocationOutcome: "valid",
    sinceReconnectMs: 1000,
  });
  if (valid !== "flush") {
    violations.push("a revalidated, still-valid session must flush");
  }
  const revoked = m.decideFlush({
    online: true,
    revalidated: true,
    revocationOutcome: "revoked",
    sinceReconnectMs: 1000,
  });
  if (revoked !== "quarantine") {
    violations.push("a session revoked while offline must be quarantined");
  }
  return violations;
};

// Fail closed on the absence of a verdict: a revalidated session with NO
// affirmative outcome yet must HOLD (and retry) — it must never flush an
// unproven session on the mere absence of a revocation result.
const failClosedOnUndefinedViolations = (m: FlushGateModule): string[] => {
  const violations: string[] = [];
  const decision = m.decideFlush({
    online: true,
    revalidated: true,
    sinceReconnectMs: 1000,
  });
  if (decision !== "hold") {
    violations.push(
      "a revalidated session with no affirmative outcome must hold, not flush"
    );
  }
  return violations;
};

// The SLA bounds are the fixed 300 s / 600 s literals.
const slaConstantViolations = (m: FlushGateModule): string[] => {
  const violations: string[] = [];
  if (m.REVOCATION_SLA_MS !== FIVE_MIN_MS) {
    violations.push("the revocation SLA must be 300 s");
  }
  if (m.REVOCATION_SLA_MAX_MS !== TEN_MIN_MS) {
    violations.push("the revocation SLA ceiling must be 600 s");
  }
  return violations;
};

// --- Single-authority source scan (replicated in the mutation twin) ----------
//
// The flush decision must live in exactly one place. Neither the offline queue
// module nor the session-state reducer may carry an independent
// revocation-outcome → decision branch; they route through the one seam.

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

// An independent decision body keys off the revocation outcome to choose a
// hold/quarantine without delegating to the seam.
const INDEPENDENT_REVOCATION_BRANCH_RE =
  /revocationOutcome\s*===\s*["']revoked["']/;

const carriesIndependentDecision = (source: string): boolean =>
  INDEPENDENT_REVOCATION_BRANCH_RE.test(stripJsComments(source));

// Load `./flush-gate` through a variable specifier + `@vite-ignore` dynamic
// import so the bundler resolves it at runtime rather than eagerly at collection
// time.
const FLUSH_GATE_SPEC = "./flush-gate";

const loadModule = async (): Promise<FlushGateModule> =>
  (await import(
    /* @vite-ignore */ FLUSH_GATE_SPEC
  )) as unknown as FlushGateModule;

const readSource = (file: string): string => readFileSync(file, "utf8");

describe("the live flush-gate revalidates before flushing and quarantines revoked-offline work", () => {
  test("an offline client never flushes the queue", async () => {
    const m = await loadModule();
    expect(offlineNeverFlushViolations(m)).toEqual([]);
  });

  test("a reconnected client must revalidate the session before any queued flush, even past the SLA window", async () => {
    const m = await loadModule();
    expect(revalidateBeforeFlushViolations(m)).toEqual([]);
  });

  test("a revalidated, still-valid session flushes while a session revoked while offline is quarantined", async () => {
    const m = await loadModule();
    expect(revalidatedOutcomeViolations(m)).toEqual([]);
  });

  test("a revalidated session with no affirmative outcome holds (fail closed) rather than flushing", async () => {
    const m = await loadModule();
    expect(failClosedOnUndefinedViolations(m)).toEqual([]);
  });

  test("the revocation SLA bounds are the fixed five-minute and ten-minute literals", async () => {
    const m = await loadModule();
    expect(slaConstantViolations(m)).toEqual([]);
  });

  test("the flush decision has a single authority — the queue and session layers do not re-derive it", () => {
    // The seam module exists and defines the decision.
    expect(carriesIndependentDecision(readSource(GATE_FILE))).toBe(true);
    // The earlier dual surfaces no longer carry an independent revocation branch.
    expect(carriesIndependentDecision(readSource(OUTBOX_FILE))).toBe(false);
    expect(carriesIndependentDecision(readSource(SESSION_STATE_FILE))).toBe(
      false
    );
  });
});
