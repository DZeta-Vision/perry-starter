import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Conformance gate for the pure, target-agnostic session-hardening policy.
//
// The policy is a PURE function of injected values — a numeric clock (`now`),
// the server-issued claim (`iat`/`exp`), the server-tracked `lastActive`, and
// refresh-token bookkeeping (`consumedAt`). The tests use only fixed numeric
// inputs: no wall clock, no connectivity API, no real timers, no live
// better-auth. A source guard asserts the absolute ceiling reads no device
// clock.
//
// RED PHASE: every test is `test.skip`. The policy module
// `packages/auth/src/session-policy.ts` does not exist yet — it lands in this
// story's dev phase. Every import of it is a dynamic `await import(...)` inside
// the skipped body; the source-guard `readFileSync` is likewise inside the
// skipped body. Top-level static imports are limited to `vitest` and `node:*`.
//
// The paired mutation twin replicates the checkers below and runs them against
// deliberately-wrong policies, proving each invariant goes red on a bad
// implementation (anti-vacuous).

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/auth/src
const POLICY_FILE = resolve(HERE, "session-policy.ts");

// Fixed windows the policy single-sources as named constants.
const THIRTY_MIN_MS = 30 * 60 * 1000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const THIRTY_SECONDS_MS = 30_000;
const REVOCATION_MARGIN_MS = 300_000; // 5 min — the get-session cache must sit strictly under this

// A fixed, injected clock origin — no wall clock is ever read.
const IAT = 1_700_000_000_000;

type IdleVerdict = "active" | "idle-expired";
type AbsoluteVerdict = "within" | "ceiling-exceeded";
type RefreshVerdict = "ok" | "ok-grace" | "replay";
type CredentialChange = "password" | "role";

interface ReplayDecision {
  readonly audit: { readonly action: string; readonly actor: string };
  readonly forceReLogin: boolean;
  readonly revokeScope: string;
}

interface RevokeDecision {
  readonly revokeScope: string;
  readonly surfaces: readonly string[];
}

// The policy surface the gate drives.
interface PolicyModule {
  readonly ABSOLUTE_SESSION_MS: number;
  readonly evaluateAbsolute: (input: {
    readonly iat: number;
    readonly now: number;
  }) => AbsoluteVerdict;
  readonly evaluateIdle: (input: {
    readonly lastActive: number;
    readonly now: number;
  }) => IdleVerdict;
  readonly GET_SESSION_CACHE_MAX_MS: number;
  readonly IDLE_TIMEOUT_MS: number;
  readonly invalidateCacheOnRevoke: () => boolean;
  readonly onRefreshReplay: (input: {
    readonly actor: string;
  }) => ReplayDecision;
  readonly REFRESH_GRACE_MS: number;
  readonly REVOCATION_MARGIN_MS: number;
  readonly revokeOnCredentialChange: (kind: CredentialChange) => RevokeDecision;
  readonly rotateRefresh: (prevTokenId: string) => {
    readonly consumedAt: number;
    readonly nextTokenId: string;
  };
  readonly SKEW_TOLERANCE_MS: number;
  readonly verifyRefresh: (input: {
    readonly consumedAt: number | undefined;
    readonly now: number;
    readonly tokenId: string;
  }) => RefreshVerdict;
}

// The audit vocabulary the persisted append-only entry enforces; the replay
// event must use a conforming session/auth action.
const AUDIT_ACTION_RE = /^(auth|session)\.[a-z][a-z0-9_]*$/;

// --- Behavioral checkers (replicated verbatim in the mutation twin) ----------

// The idle window trips at 30 min measured from the server-tracked last-active.
const idleViolations = (m: PolicyModule): string[] => {
  const violations: string[] = [];
  if (m.IDLE_TIMEOUT_MS !== THIRTY_MIN_MS) {
    violations.push("idle window must be 30 minutes");
  }
  const justBefore = m.evaluateIdle({
    lastActive: IAT,
    now: IAT + m.IDLE_TIMEOUT_MS - 1,
  });
  if (justBefore !== "active") {
    violations.push("just before the idle window the session is still active");
  }
  const atEdge = m.evaluateIdle({
    lastActive: IAT,
    now: IAT + m.IDLE_TIMEOUT_MS,
  });
  if (atEdge !== "idle-expired") {
    violations.push("at the idle window the session is idle-expired");
  }
  return violations;
};

// The absolute ceiling is iat + 8h (server claim), and tracks the iat: shifting
// iat by +1h shifts the exit boundary by exactly +1h. A device-time ceiling
// would never move with the injected claim.
const ceilingViolations = (m: PolicyModule): string[] => {
  const violations: string[] = [];
  if (m.ABSOLUTE_SESSION_MS !== EIGHT_HOURS_MS) {
    violations.push("absolute ceiling must be 8 hours");
  }
  const ceiling = IAT + m.ABSOLUTE_SESSION_MS;
  if (m.evaluateAbsolute({ iat: IAT, now: ceiling - 1 }) !== "within") {
    violations.push("just below the ceiling the session is within bounds");
  }
  if (m.evaluateAbsolute({ iat: IAT, now: ceiling }) !== "ceiling-exceeded") {
    violations.push("at the ceiling the session is ceiling-exceeded");
  }
  const shift = 60 * 60 * 1000;
  const shifted = IAT + shift;
  const shiftedCeiling = ceiling + shift;
  if (
    m.evaluateAbsolute({ iat: shifted, now: shiftedCeiling - 1 }) !== "within"
  ) {
    violations.push("the ceiling must track the server iat (+1h shift)");
  }
  if (
    m.evaluateAbsolute({ iat: shifted, now: shiftedCeiling }) !==
    "ceiling-exceeded"
  ) {
    violations.push(
      "a device-time ceiling that ignores the iat shift is rejected"
    );
  }
  return violations;
};

// The skew slack is a fixed bound ≤ the idle window.
const skewViolations = (m: PolicyModule): string[] => {
  const violations: string[] = [];
  if (!(m.SKEW_TOLERANCE_MS > 0)) {
    violations.push("skew tolerance must be a positive fixed bound");
  }
  if (m.SKEW_TOLERANCE_MS > m.IDLE_TIMEOUT_MS) {
    violations.push("skew tolerance must be ≤ the idle window");
  }
  return violations;
};

// A refresh token is single-use: rotating supersedes it; a consumed token past
// the fixed grace is a replay; within the grace it is tolerated.
const rotationViolations = (m: PolicyModule): string[] => {
  const violations: string[] = [];
  if (m.REFRESH_GRACE_MS !== THIRTY_SECONDS_MS) {
    violations.push("refresh grace must be the fixed 30 s literal");
  }
  const rotated = m.rotateRefresh("token-a");
  if (rotated.nextTokenId === "token-a") {
    violations.push("rotation must mint a new token id");
  }
  const fresh = m.verifyRefresh({
    tokenId: rotated.nextTokenId,
    consumedAt: undefined,
    now: rotated.consumedAt + 5,
  });
  if (fresh !== "ok") {
    violations.push("an unconsumed token verifies ok");
  }
  const withinGrace = m.verifyRefresh({
    tokenId: "token-a",
    consumedAt: rotated.consumedAt,
    now: rotated.consumedAt + m.REFRESH_GRACE_MS,
  });
  if (withinGrace !== "ok-grace") {
    violations.push("a consumed token within the grace is tolerated");
  }
  const pastGrace = m.verifyRefresh({
    tokenId: "token-a",
    consumedAt: rotated.consumedAt,
    now: rotated.consumedAt + m.REFRESH_GRACE_MS + 1,
  });
  if (pastGrace !== "replay") {
    violations.push("a consumed token past the grace is a replay");
  }
  return violations;
};

// A detected replay revokes every session, forces re-login, and emits a
// conforming audit event.
const replayDecisionViolations = (m: PolicyModule): string[] => {
  const violations: string[] = [];
  const decision = m.onRefreshReplay({ actor: "user:alice" });
  if (decision.revokeScope !== "all-sessions") {
    violations.push("a replay must revoke all sessions");
  }
  if (decision.forceReLogin !== true) {
    violations.push("a replay must force re-login");
  }
  if (!AUDIT_ACTION_RE.test(decision.audit.action)) {
    violations.push(
      "the replay audit action must match the session/auth vocabulary"
    );
  }
  if (decision.audit.actor.length === 0) {
    violations.push("the replay audit event must name an actor");
  }
  return violations;
};

// A password or role change revokes across BOTH surfaces (all sessions).
const revokeOnChangeViolations = (m: PolicyModule): string[] => {
  const violations: string[] = [];
  for (const kind of ["password", "role"] as const) {
    const decision = m.revokeOnCredentialChange(kind);
    if (decision.revokeScope !== "all-sessions") {
      violations.push(`${kind} change must revoke all sessions`);
    }
    if (
      !(
        decision.surfaces.includes("cloud") &&
        decision.surfaces.includes("local")
      )
    ) {
      violations.push(`${kind} change must revoke both surfaces`);
    }
  }
  return violations;
};

// The get-session cache TTL sits strictly under the revocation margin and is
// actively invalidated on revoke (not left to TTL expiry).
const cacheMarginViolations = (m: PolicyModule): string[] => {
  const violations: string[] = [];
  if (m.REVOCATION_MARGIN_MS !== REVOCATION_MARGIN_MS) {
    violations.push("the revocation margin must be 300 s");
  }
  if (!(m.GET_SESSION_CACHE_MAX_MS > 0)) {
    violations.push("the get-session cache TTL must be positive");
  }
  if (!(m.GET_SESSION_CACHE_MAX_MS < m.REVOCATION_MARGIN_MS)) {
    violations.push(
      "the get-session cache TTL must sit strictly under the margin"
    );
  }
  if (m.invalidateCacheOnRevoke() !== true) {
    violations.push("revoke must actively invalidate the cache");
  }
  return violations;
};

// --- Source-scan detectors (replicated verbatim in the mutation twin) --------

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

// The pure core reads no device clock.
const REAL_TIME_SOURCES = [
  /\bDate\.now\b/,
  /\bperformance\.now\b/,
  /\bsetTimeout\b/,
  /\bsetInterval\b/,
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

// The pure policy pulls no server-auth graph.
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

const loadModule = async (): Promise<PolicyModule> =>
  (await import("./session-policy")) as unknown as PolicyModule;

const readSource = (): string => readFileSync(POLICY_FILE, "utf8");

describe("the session-hardening policy enforces the timeout, rotation, and revocation invariants", () => {
  test("the idle window trips at thirty minutes, measured from the server-tracked last-active reading", async () => {
    const m = await loadModule();
    expect(idleViolations(m)).toEqual([]);
  });

  test("the absolute ceiling is the server-issued iat plus eight hours and tracks the iat rather than the device clock", async () => {
    const m = await loadModule();
    expect(ceilingViolations(m)).toEqual([]);
  });

  test("the skew slack is a fixed bound no larger than the idle window", async () => {
    const m = await loadModule();
    expect(skewViolations(m)).toEqual([]);
  });

  test("a refresh token is single-use: rotation supersedes it and a replay past the fixed thirty-second grace is detected", async () => {
    const m = await loadModule();
    expect(rotationViolations(m)).toEqual([]);
  });

  test("a detected replay revokes every session, forces re-login, and emits a conforming audit event", async () => {
    const m = await loadModule();
    expect(replayDecisionViolations(m)).toEqual([]);
  });

  test("a password or role change revokes the session across both surfaces", async () => {
    const m = await loadModule();
    expect(revokeOnChangeViolations(m)).toEqual([]);
  });

  test("the get-session cache lifetime sits strictly under the revocation margin and is actively invalidated on revoke", async () => {
    const m = await loadModule();
    expect(cacheMarginViolations(m)).toEqual([]);
  });

  test("the policy core reads no device clock and pulls no server-auth graph", () => {
    const source = readSource();
    expect(findRealTimeReads(source)).toEqual([]);
    expect(findForbiddenAuthImports(source)).toEqual([]);
  });
});
