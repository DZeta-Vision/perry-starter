import { describe, expect, test } from "vitest";

// Anti-vacuous twin for the session-hardening policy gate. The gate's checkers
// are replicated here and run against deliberately-wrong, self-contained inline
// policies (no import of the real module), proving each invariant goes RED on a
// bad implementation and GREEN on a correct control.
//
// RED PHASE: every test is `test.skip` to match the gate's red phase; the
// checkers and inline fixtures are self-contained so collection never throws.

const THIRTY_MIN_MS = 30 * 60 * 1000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const THIRTY_SECONDS_MS = 30_000;
const REVOCATION_MARGIN_MS = 300_000;

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

const AUDIT_ACTION_RE = /^(auth|session)\.[a-z][a-z0-9_]*$/;

// --- Replicated checkers (verbatim with the gate) ----------------------------

const ceilingViolations = (m: PolicyModule): string[] => {
  const violations: string[] = [];
  const ceiling = IAT + m.ABSOLUTE_SESSION_MS;
  const shift = 60 * 60 * 1000;
  const shifted = IAT + shift;
  const shiftedCeiling = ceiling + shift;
  if (
    m.evaluateAbsolute({ iat: shifted, now: shiftedCeiling }) !==
    "ceiling-exceeded"
  ) {
    violations.push(
      "a device-time ceiling that ignores the iat shift is rejected"
    );
  }
  if (
    m.evaluateAbsolute({ iat: shifted, now: shiftedCeiling - 1 }) !== "within"
  ) {
    violations.push("the ceiling must track the server iat (+1h shift)");
  }
  return violations;
};

const rotationViolations = (m: PolicyModule): string[] => {
  const violations: string[] = [];
  if (m.REFRESH_GRACE_MS !== THIRTY_SECONDS_MS) {
    violations.push("refresh grace must be the fixed 30 s literal");
  }
  const rotated = m.rotateRefresh("token-a");
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

const replayDecisionViolations = (m: PolicyModule): string[] => {
  const violations: string[] = [];
  const decision = m.onRefreshReplay({ actor: "user:alice" });
  if (decision.revokeScope !== "all-sessions") {
    violations.push("a replay must revoke all sessions");
  }
  if (!AUDIT_ACTION_RE.test(decision.audit.action)) {
    violations.push(
      "the replay audit action must match the session/auth vocabulary"
    );
  }
  return violations;
};

const revokeOnChangeViolations = (m: PolicyModule): string[] => {
  const violations: string[] = [];
  for (const kind of ["password", "role"] as const) {
    const decision = m.revokeOnCredentialChange(kind);
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

const cacheMarginViolations = (m: PolicyModule): string[] => {
  const violations: string[] = [];
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

const skewViolations = (m: PolicyModule): string[] => {
  const violations: string[] = [];
  if (m.SKEW_TOLERANCE_MS > m.IDLE_TIMEOUT_MS) {
    violations.push("skew tolerance must be ≤ the idle window");
  }
  return violations;
};

// --- Controls + deliberately-wrong fixtures ----------------------------------

const correct: PolicyModule = {
  ABSOLUTE_SESSION_MS: EIGHT_HOURS_MS,
  IDLE_TIMEOUT_MS: THIRTY_MIN_MS,
  SKEW_TOLERANCE_MS: 5 * 60 * 1000,
  REFRESH_GRACE_MS: THIRTY_SECONDS_MS,
  REVOCATION_MARGIN_MS,
  GET_SESSION_CACHE_MAX_MS: 60_000,
  evaluateIdle: ({ lastActive, now }) =>
    now >= lastActive + THIRTY_MIN_MS ? "idle-expired" : "active",
  evaluateAbsolute: ({ iat, now }) =>
    now >= iat + EIGHT_HOURS_MS ? "ceiling-exceeded" : "within",
  rotateRefresh: (prev) => ({ nextTokenId: `${prev}+1`, consumedAt: IAT }),
  verifyRefresh: ({ consumedAt, now }) => {
    if (consumedAt === undefined) {
      return "ok";
    }
    if (now <= consumedAt + THIRTY_SECONDS_MS) {
      return "ok-grace";
    }
    return "replay";
  },
  onRefreshReplay: ({ actor }) => ({
    revokeScope: "all-sessions",
    forceReLogin: true,
    audit: { action: "session.refresh_replay_revoked", actor },
  }),
  revokeOnCredentialChange: () => ({
    revokeScope: "all-sessions",
    surfaces: ["cloud", "local"],
  }),
  invalidateCacheOnRevoke: () => true,
};

// A ceiling computed from a device "now + 8h" rather than the server iat: it
// never tracks the iat shift.
const deviceTimeCeiling: PolicyModule = {
  ...correct,
  evaluateAbsolute: ({ now }) =>
    // Ignores iat entirely — a stand-in for `Date.now() + 8h` device math.
    now >= IAT + EIGHT_HOURS_MS ? "ceiling-exceeded" : "within",
};

// A ledger that never flags a consumed token as replay.
const replayBlind: PolicyModule = {
  ...correct,
  verifyRefresh: ({ consumedAt }) =>
    consumedAt === undefined ? "ok" : "ok-grace",
};

// A replay decision that does not revoke all sessions and uses a bad action.
const weakReplay: PolicyModule = {
  ...correct,
  onRefreshReplay: ({ actor }) => ({
    revokeScope: "current-session",
    forceReLogin: false,
    audit: { action: "bogus", actor },
  }),
};

// A revoke that touches only one surface.
const singleSurfaceRevoke: PolicyModule = {
  ...correct,
  revokeOnCredentialChange: () => ({
    revokeScope: "all-sessions",
    surfaces: ["cloud"],
  }),
};

// A cache that lingers at or beyond the margin and never actively invalidates.
const lingeringCache: PolicyModule = {
  ...correct,
  GET_SESSION_CACHE_MAX_MS: REVOCATION_MARGIN_MS,
  invalidateCacheOnRevoke: () => false,
};

// A skew slack wider than the idle window.
const wideSkew: PolicyModule = {
  ...correct,
  SKEW_TOLERANCE_MS: THIRTY_MIN_MS + 1,
};

describe("the session-policy gate rejects broken hardening policies", () => {
  test("a ceiling computed from device time instead of the server iat reddens", () => {
    expect(ceilingViolations(correct)).toEqual([]);
    expect(ceilingViolations(deviceTimeCeiling).length).toBeGreaterThan(0);
  });

  test("a ledger that never flags a consumed token past the grace as replay reddens", () => {
    expect(rotationViolations(correct)).toEqual([]);
    expect(rotationViolations(replayBlind).length).toBeGreaterThan(0);
  });

  test("a replay decision that spares sessions or skips the audit event reddens", () => {
    expect(replayDecisionViolations(correct)).toEqual([]);
    expect(replayDecisionViolations(weakReplay).length).toBeGreaterThan(0);
  });

  test("a credential-change revoke that touches a single surface reddens", () => {
    expect(revokeOnChangeViolations(correct)).toEqual([]);
    expect(
      revokeOnChangeViolations(singleSurfaceRevoke).length
    ).toBeGreaterThan(0);
  });

  test("a cache that lingers at the margin or never actively invalidates reddens", () => {
    expect(cacheMarginViolations(correct)).toEqual([]);
    expect(cacheMarginViolations(lingeringCache).length).toBeGreaterThan(0);
  });

  test("a skew slack wider than the idle window reddens", () => {
    expect(skewViolations(correct)).toEqual([]);
    expect(skewViolations(wideSkew).length).toBeGreaterThan(0);
  });
});
