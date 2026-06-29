import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Conformance gate for the pure, target-agnostic offline session-state reducer.
//
// The reducer is a PURE function of an injected `now` (clock reading) and an
// injected `online` (connectivity boolean): the tests use only fixed numeric
// clocks and boolean connectivity — no wall clock, no connectivity API, no real
// timers. A source guard asserts the reducer reads none of those either.
//
// The paired mutation twin (`session-state.mutation.test.ts`) replicates the
// checkers below and runs them against deliberately-wrong reducers, proving each
// invariant goes red on a bad implementation (anti-vacuous).

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/auth/src
const SESSION_STATE_FILE = resolve(HERE, "session-state.ts");

// Fixed session windows (the reducer single-sources these as named constants).
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const THIRTY_MIN_MS = 30 * 60 * 1000;

// A fixed, injected clock origin — no wall-clock is ever read.
const IAT = 1_700_000_000_000;
const TOKEN_TTL_MS = 60_000; // short-lived access token
const SCOPE = "user:alice";

type SessionState = "AUTHENTICATED" | "LOCAL_GRACE" | "SESSION_EXPIRED";

interface SessionClaims {
  readonly exp: number;
  readonly iat: number;
  readonly scope_user_id: string;
}

interface EvaluateInput {
  readonly claims: SessionClaims;
  readonly now: number;
  readonly online: boolean;
  readonly refreshOutcome?: "ok" | "failed";
}

interface FlushInput {
  readonly online: boolean;
  readonly revocationOutcome?: "valid" | "revoked";
  readonly state: SessionState;
}

// The reducer surface the gate drives.
interface SessionModule {
  readonly ABSOLUTE_SESSION_MS: number;
  readonly canEnqueue: (state: SessionState) => boolean;
  readonly canFlush: (input: FlushInput) => "hold" | boolean;
  readonly evaluateSession: (input: EvaluateInput) => SessionState;
  readonly guardDataAccess: (state: SessionState) => "allow" | "block";
  readonly IDLE_TIMEOUT_MS: number;
  readonly SKEW_TOLERANCE_MS: number;
}

const claimsAt = (iat: number): SessionClaims => ({
  iat,
  exp: iat + TOKEN_TTL_MS,
  scope_user_id: SCOPE,
});

// --- Behavioral checkers (replicated verbatim in the mutation twin) ----------

// While offline (no connectivity event), the client never degrades — the data
// path is always permitted and the state is never SESSION_EXPIRED, for every
// clock value across the full {pre-expiry, grace, past-ceiling} sweep.
const offlineNeverDegradeViolations = (
  m: SessionModule,
  claims: SessionClaims
): string[] => {
  const ceiling = claims.iat + m.ABSOLUTE_SESSION_MS;
  const offlineClocks = [
    claims.iat + TOKEN_TTL_MS / 2, // pre-expiry
    claims.exp + m.SKEW_TOLERANCE_MS + 1, // just past skew (grace)
    claims.iat + Math.floor(m.ABSOLUTE_SESSION_MS / 2), // mid-grace
    ceiling, // at ceiling
    ceiling + m.SKEW_TOLERANCE_MS + 1, // past ceiling
  ];
  const violations: string[] = [];
  for (const now of offlineClocks) {
    const state = m.evaluateSession({ claims, now, online: false });
    if (state === "SESSION_EXPIRED") {
      violations.push(`offline now=${now}: degraded to SESSION_EXPIRED`);
    }
    if (m.guardDataAccess(state) !== "allow") {
      violations.push(`offline now=${now}: data path blocked (state=${state})`);
    }
  }
  return violations;
};

// The offline clock regions map to the right state labels.
const offlineRegionViolations = (
  m: SessionModule,
  claims: SessionClaims
): string[] => {
  const ceiling = claims.iat + m.ABSOLUTE_SESSION_MS;
  const violations: string[] = [];
  const preExpiry = m.evaluateSession({
    claims,
    now: claims.iat + TOKEN_TTL_MS / 2,
    online: false,
  });
  if (preExpiry !== "AUTHENTICATED") {
    violations.push(
      `pre-expiry offline should be AUTHENTICATED, got ${preExpiry}`
    );
  }
  const inGrace = m.evaluateSession({
    claims,
    now: claims.iat + Math.floor(m.ABSOLUTE_SESSION_MS / 2),
    online: false,
  });
  if (inGrace !== "LOCAL_GRACE") {
    violations.push(`offline-expiry should be LOCAL_GRACE, got ${inGrace}`);
  }
  const pastCeiling = m.evaluateSession({
    claims,
    now: ceiling + 1,
    online: false,
  });
  if (pastCeiling === "LOCAL_GRACE") {
    violations.push("past-ceiling offline must NOT remain LOCAL_GRACE");
  }
  return violations;
};

// SESSION_EXPIRED is reachable ONLY from {online:true, refreshOutcome:"failed"};
// an `ok` refresh on reconnect returns to AUTHENTICATED; no offline row produces
// SESSION_EXPIRED.
const sessionExpiredScopeViolations = (
  m: SessionModule,
  claims: SessionClaims
): string[] => {
  const violations: string[] = [];
  const expiredNow = claims.exp + m.SKEW_TOLERANCE_MS + 1;
  const failed = m.evaluateSession({
    claims,
    now: expiredNow,
    online: true,
    refreshOutcome: "failed",
  });
  if (failed !== "SESSION_EXPIRED") {
    violations.push(`{online,failed} must be SESSION_EXPIRED, got ${failed}`);
  }
  const ok = m.evaluateSession({
    claims,
    now: expiredNow,
    online: true,
    refreshOutcome: "ok",
  });
  if (ok === "SESSION_EXPIRED") {
    violations.push("a successful refresh must NOT be SESSION_EXPIRED");
  }
  const offline = m.evaluateSession({ claims, now: expiredNow, online: false });
  if (offline === "SESSION_EXPIRED") {
    violations.push("offline expiry must NOT be SESSION_EXPIRED");
  }
  return violations;
};

// The data path is open for AUTHENTICATED + LOCAL_GRACE, blocked only for
// SESSION_EXPIRED; `enqueue` is permitted in LOCAL_GRACE.
const dataPathViolations = (m: SessionModule): string[] => {
  const violations: string[] = [];
  if (m.guardDataAccess("AUTHENTICATED") !== "allow") {
    violations.push("AUTHENTICATED must allow data access");
  }
  if (m.guardDataAccess("LOCAL_GRACE") !== "allow") {
    violations.push("LOCAL_GRACE must allow data access");
  }
  if (m.guardDataAccess("SESSION_EXPIRED") !== "block") {
    violations.push("SESSION_EXPIRED must block data access");
  }
  if (!m.canEnqueue("LOCAL_GRACE")) {
    violations.push("enqueue must be permitted in LOCAL_GRACE");
  }
  if (m.canEnqueue("SESSION_EXPIRED")) {
    violations.push("enqueue must be blocked once SESSION_EXPIRED");
  }
  return violations;
};

// The skew tolerance is a fixed bound ≤ the idle window, applied to the
// short-lived-token EXPIRY check only (never the ceiling).
const skewBoundViolations = (
  m: SessionModule,
  claims: SessionClaims
): string[] => {
  const violations: string[] = [];
  if (!(m.SKEW_TOLERANCE_MS > 0)) {
    violations.push("SKEW_TOLERANCE_MS must be a positive fixed bound");
  }
  if (m.SKEW_TOLERANCE_MS > m.IDLE_TIMEOUT_MS) {
    violations.push("SKEW_TOLERANCE_MS must be ≤ IDLE_TIMEOUT_MS");
  }
  // Within ±skew of expiry the token is still treated as live.
  const liveAtEdge = m.evaluateSession({
    claims,
    now: claims.exp + m.SKEW_TOLERANCE_MS,
    online: false,
  });
  if (liveAtEdge !== "AUTHENTICATED") {
    violations.push("within +skew of exp the token must still be live");
  }
  // One ms past the skew the offline token has expired into LOCAL_GRACE.
  const expiredPastSkew = m.evaluateSession({
    claims,
    now: claims.exp + m.SKEW_TOLERANCE_MS + 1,
    online: false,
  });
  if (expiredPastSkew !== "LOCAL_GRACE") {
    violations.push("past +skew the offline token must be LOCAL_GRACE");
  }
  // The skew slack is NOT added to the ceiling: just past the ceiling (and well
  // within +skew of it) must already be out of LOCAL_GRACE.
  const ceiling = claims.iat + m.ABSOLUTE_SESSION_MS;
  const justPastCeiling = m.evaluateSession({
    claims,
    now: ceiling + 1,
    online: false,
  });
  if (justPastCeiling === "LOCAL_GRACE") {
    violations.push("skew must NOT extend LOCAL_GRACE past the ceiling");
  }
  return violations;
};

// The absolute ceiling is `iat + ABSOLUTE_SESSION_MS` (server-issued claim), NOT
// device time, and skew can never push an at-or-past-ceiling `now` back into
// LOCAL_GRACE. Proven behaviorally: the LOCAL_GRACE→exit boundary TRACKS `iat`
// (a device-time ceiling would never exit), and a full +skew sweep past the
// ceiling never re-enters LOCAL_GRACE.
const ceilingViolations = (m: SessionModule, iat: number): string[] => {
  const violations: string[] = [];
  const claims = claimsAt(iat);
  const ceiling = iat + m.ABSOLUTE_SESSION_MS;
  // The boundary tracks the server iat: shift iat by +1h and the exit boundary
  // shifts by exactly +1h (device "now" is the same injected value).
  const shift = 60 * 60 * 1000;
  const claims2 = claimsAt(iat + shift);
  const ceiling2 = ceiling + shift;
  const belowCeiling2 = m.evaluateSession({
    claims: claims2,
    now: ceiling2 - 1,
    online: false,
  });
  if (belowCeiling2 !== "LOCAL_GRACE") {
    violations.push("just below the iat-derived ceiling must be LOCAL_GRACE");
  }
  const atShiftedCeiling = m.evaluateSession({
    claims: claims2,
    now: ceiling2,
    online: false,
  });
  if (atShiftedCeiling === "LOCAL_GRACE") {
    violations.push(
      "ceiling must track server iat (device-time ceiling rejected)"
    );
  }
  // Skew sweep: every now ≥ ceiling exits LOCAL_GRACE regardless of skew.
  for (const delta of [0, 1, m.SKEW_TOLERANCE_MS, m.SKEW_TOLERANCE_MS + 1]) {
    const state = m.evaluateSession({
      claims,
      now: ceiling + delta,
      online: false,
    });
    if (state === "LOCAL_GRACE") {
      violations.push(`now=ceiling+${delta} must NOT be LOCAL_GRACE`);
    }
  }
  return violations;
};

// The flush-gate stub never permits a flush while offline, and HOLDS (does not
// flush) when the injected revocation outcome is `revoked`.
const canFlushViolations = (m: SessionModule): string[] => {
  const violations: string[] = [];
  if (m.canFlush({ state: "LOCAL_GRACE", online: false }) !== false) {
    violations.push("canFlush must be false while offline");
  }
  if (m.canFlush({ state: "AUTHENTICATED", online: false }) !== false) {
    violations.push("canFlush must be false while offline (any state)");
  }
  const revoked = m.canFlush({
    state: "AUTHENTICATED",
    online: true,
    revocationOutcome: "revoked",
  });
  if (revoked !== "hold") {
    violations.push("canFlush must HOLD when revocation outcome is revoked");
  }
  return violations;
};

// --- Source-scan detectors (replicated verbatim in the mutation twin) --------

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

// The pure core reads no wall clock / connectivity / timers.
const REAL_TIME_SOURCES = [
  /\bDate\.now\b/,
  /\bperformance\.now\b/,
  /\bsetTimeout\b/,
  /\bsetInterval\b/,
  /\bnavigator\.onLine\b/,
] as const;

const findRealTimeReads = (source: string): string[] => {
  const code = stripJsComments(source);
  const hits: string[] = [];
  for (const re of REAL_TIME_SOURCES) {
    if (re.test(code)) {
      hits.push(re.source);
    }
  }
  return hits;
};

// The daemon-facing pure module pulls no server-auth graph.
const IMPORT_SPECIFIER_RE =
  /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

const isForbiddenAuthImport = (specifier: string): boolean =>
  specifier === "better-auth" ||
  specifier.startsWith("better-auth/") ||
  specifier === "@perry-starter/env" ||
  specifier.startsWith("@perry-starter/env/");

const findForbiddenAuthImports = (source: string): string[] => {
  const hits: string[] = [];
  for (const match of stripJsComments(source).matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[1];
    if (specifier !== undefined && isForbiddenAuthImport(specifier)) {
      hits.push(specifier);
    }
  }
  return hits;
};

const loadModule = async (): Promise<SessionModule> =>
  (await import("./session-state")) as unknown as SessionModule;

const readSource = (): string => readFileSync(SESSION_STATE_FILE, "utf8");

describe("the LOCAL_GRACE reducer holds the never-degrade + bounds invariants", () => {
  test("while offline the client never degrades to SESSION_EXPIRED and the data path is never blocked, across the full clock sweep", async () => {
    const m = await loadModule();
    expect(offlineNeverDegradeViolations(m, claimsAt(IAT))).toEqual([]);
  });

  test("going offline before expiry keeps AUTHENTICATED with the data path open — re-auth requires a FAILED refresh, never the offline edge", async () => {
    const m = await loadModule();
    expect(offlineRegionViolations(m, claimsAt(IAT))).toEqual([]);
    expect(dataPathViolations(m)).toEqual([]);
  });

  test("an offline-expired token enters LOCAL_GRACE (not SESSION_EXPIRED) and enqueue stays permitted", async () => {
    const m = await loadModule();
    const claims = claimsAt(IAT);
    const state = m.evaluateSession({
      claims,
      now: claims.iat + Math.floor(m.ABSOLUTE_SESSION_MS / 2),
      online: false,
    });
    expect(state).toBe("LOCAL_GRACE");
    expect(m.guardDataAccess(state)).toBe("allow");
    expect(m.canEnqueue(state)).toBe(true);
  });

  test("SESSION_EXPIRED fires only on {online:true, refreshOutcome:'failed'}; a successful reconnect refresh returns to AUTHENTICATED", async () => {
    const m = await loadModule();
    expect(sessionExpiredScopeViolations(m, claimsAt(IAT))).toEqual([]);
  });

  test("skew tolerance is a fixed bound ≤ IDLE_TIMEOUT_MS applied to the expiry check only", async () => {
    const m = await loadModule();
    expect(m.ABSOLUTE_SESSION_MS).toBe(EIGHT_HOURS_MS);
    expect(m.IDLE_TIMEOUT_MS).toBe(THIRTY_MIN_MS);
    expect(skewBoundViolations(m, claimsAt(IAT))).toEqual([]);
  });

  test("the absolute ceiling is iat + ABSOLUTE_SESSION_MS (server time, never device time); skew can never extend LOCAL_GRACE past it", async () => {
    const m = await loadModule();
    expect(ceilingViolations(m, IAT)).toEqual([]);
  });

  test("canFlush is false while offline and HOLDS on a revoked outcome", async () => {
    const m = await loadModule();
    expect(canFlushViolations(m)).toEqual([]);
  });

  test("the pure reducer source references no Date.now / performance.now / setTimeout / setInterval / navigator.onLine", () => {
    expect(findRealTimeReads(readSource())).toEqual([]);
  });

  test("the session-state graph imports no better-auth and no @perry-starter/env (tier-boundary cleanliness)", () => {
    expect(findForbiddenAuthImports(readSource())).toEqual([]);
  });
});
