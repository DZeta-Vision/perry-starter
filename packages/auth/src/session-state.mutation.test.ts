import { describe, expect, test } from "vitest";

// Mutation twin for session-state.gate.test.ts — the anti-vacuous proof.
//
// The gate's behavioral checkers and source detectors are replicated here and
// run against deliberately-wrong reducers (and planted-bad source strings). Each
// twin asserts the matching invariant goes RED on a bad implementation, with a
// clean control proving the checker is not always-red. The real reducer module
// is never imported here — the twin proves the GATE's logic discriminates, so it
// is self-contained.

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

interface SessionModule {
  readonly ABSOLUTE_SESSION_MS: number;
  readonly canEnqueue: (state: SessionState) => boolean;
  readonly evaluateSession: (input: EvaluateInput) => SessionState;
  readonly guardDataAccess: (state: SessionState) => "allow" | "block";
  readonly IDLE_TIMEOUT_MS: number;
  readonly mustForceRefresh: (input: EvaluateInput) => boolean;
  readonly SKEW_TOLERANCE_MS: number;
}

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const THIRTY_MIN_MS = 30 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;
const IAT = 1_700_000_000_000;
const TOKEN_TTL_MS = 60_000;
const SCOPE = "user:alice";

const claimsAt = (iat: number): SessionClaims => ({
  iat,
  exp: iat + TOKEN_TTL_MS,
  scope_user_id: SCOPE,
});

// --- Configurable reducer: correct by default, one knob per mutation ---------

interface ReducerOverrides {
  readonly blockLocalGrace?: boolean; // guardDataAccess blocks LOCAL_GRACE
  readonly ceilingFromDeviceTime?: boolean; // ceiling = now + 8h (device time)
  readonly degradeOfflineExpiry?: boolean; // offline-expiry → SESSION_EXPIRED
  readonly expireOnOkRefresh?: boolean; // an `ok` refresh → SESSION_EXPIRED
  readonly neverForceRefresh?: boolean; // trust a past-ceiling token (no refresh)
  readonly reauthOnOfflineEdge?: boolean; // any offline row → SESSION_EXPIRED
  readonly skewMs?: number; // override the fixed skew bound
  readonly skewOnCeiling?: boolean; // apply skew slack to the ceiling
}

const makeModule = (overrides: ReducerOverrides = {}): SessionModule => {
  const skew = overrides.skewMs ?? FIVE_MIN_MS;
  const evaluateSession = ({
    claims,
    now,
    online,
    refreshOutcome,
  }: EvaluateInput): SessionState => {
    if (online) {
      if (refreshOutcome === "failed") {
        return "SESSION_EXPIRED";
      }
      if (refreshOutcome === "ok") {
        return overrides.expireOnOkRefresh
          ? "SESSION_EXPIRED"
          : "AUTHENTICATED";
      }
    }
    if (!online && overrides.reauthOnOfflineEdge) {
      return "SESSION_EXPIRED";
    }
    const ceiling = overrides.ceilingFromDeviceTime
      ? now + EIGHT_HOURS_MS
      : claims.iat + EIGHT_HOURS_MS;
    const ceilingSlack = overrides.skewOnCeiling ? skew : 0;
    if (now >= ceiling + ceilingSlack) {
      // Past the ceiling, still never a hard offline logout (stays operational).
      return "AUTHENTICATED";
    }
    if (now > claims.exp + skew) {
      return overrides.degradeOfflineExpiry ? "SESSION_EXPIRED" : "LOCAL_GRACE";
    }
    return "AUTHENTICATED";
  };
  const guardDataAccess = (state: SessionState): "allow" | "block" => {
    if (overrides.blockLocalGrace && state === "LOCAL_GRACE") {
      return "block";
    }
    return state === "SESSION_EXPIRED" ? "block" : "allow";
  };
  return {
    ABSOLUTE_SESSION_MS: EIGHT_HOURS_MS,
    IDLE_TIMEOUT_MS: THIRTY_MIN_MS,
    SKEW_TOLERANCE_MS: skew,
    canEnqueue: (state) => guardDataAccess(state) === "allow",
    evaluateSession,
    guardDataAccess,
    mustForceRefresh: ({ claims, now, online, refreshOutcome }) => {
      if (overrides.neverForceRefresh) {
        return false;
      }
      return (
        online &&
        refreshOutcome === undefined &&
        now >= claims.iat + EIGHT_HOURS_MS
      );
    },
  };
};

// --- Checkers (replicated from the gate) -------------------------------------

const offlineNeverDegradeViolations = (
  m: SessionModule,
  claims: SessionClaims
): string[] => {
  const ceiling = claims.iat + m.ABSOLUTE_SESSION_MS;
  const offlineClocks = [
    claims.iat + TOKEN_TTL_MS / 2,
    claims.exp + m.SKEW_TOLERANCE_MS + 1,
    claims.iat + Math.floor(m.ABSOLUTE_SESSION_MS / 2),
    ceiling,
    ceiling + m.SKEW_TOLERANCE_MS + 1,
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

const offlineRegionViolations = (
  m: SessionModule,
  claims: SessionClaims
): string[] => {
  const violations: string[] = [];
  const inGrace = m.evaluateSession({
    claims,
    now: claims.iat + Math.floor(m.ABSOLUTE_SESSION_MS / 2),
    online: false,
  });
  if (inGrace !== "LOCAL_GRACE") {
    violations.push(`offline-expiry should be LOCAL_GRACE, got ${inGrace}`);
  }
  return violations;
};

const sessionExpiredScopeViolations = (
  m: SessionModule,
  claims: SessionClaims
): string[] => {
  const violations: string[] = [];
  const expiredNow = claims.exp + m.SKEW_TOLERANCE_MS + 1;
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

const dataPathViolations = (m: SessionModule): string[] => {
  const violations: string[] = [];
  if (m.guardDataAccess("LOCAL_GRACE") !== "allow") {
    violations.push("LOCAL_GRACE must allow data access");
  }
  if (!m.canEnqueue("LOCAL_GRACE")) {
    violations.push("enqueue must be permitted in LOCAL_GRACE");
  }
  return violations;
};

const skewBoundViolations = (m: SessionModule): string[] => {
  const violations: string[] = [];
  if (m.SKEW_TOLERANCE_MS > m.IDLE_TIMEOUT_MS) {
    violations.push("SKEW_TOLERANCE_MS must be ≤ IDLE_TIMEOUT_MS");
  }
  return violations;
};

const ceilingViolations = (m: SessionModule, iat: number): string[] => {
  const violations: string[] = [];
  const claims = claimsAt(iat);
  const ceiling = iat + m.ABSOLUTE_SESSION_MS;
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

const mustForceRefreshViolations = (
  m: SessionModule,
  claims: SessionClaims
): string[] => {
  const violations: string[] = [];
  const ceiling = claims.iat + m.ABSOLUTE_SESSION_MS;
  if (!m.mustForceRefresh({ claims, now: ceiling, online: true })) {
    violations.push(
      "past the ceiling an online client with no refresh result must force a refresh"
    );
  }
  if (
    m.mustForceRefresh({
      claims,
      now: claims.iat + TOKEN_TTL_MS / 2,
      online: true,
    })
  ) {
    violations.push("below the ceiling no forced refresh is required");
  }
  if (m.mustForceRefresh({ claims, now: ceiling + 1, online: false })) {
    violations.push("an offline client must never be forced to refresh");
  }
  if (
    m.mustForceRefresh({
      claims,
      now: ceiling + 1,
      online: true,
      refreshOutcome: "ok",
    })
  ) {
    violations.push(
      "once a refresh result is in hand no further forced refresh is required"
    );
  }
  return violations;
};

// --- Source detector (replicated from the gate) ------------------------------

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

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

describe("the never-degrade checker fires on a degrading reducer", () => {
  test("a reducer that re-auths on the mere offline edge reddens never-degrade; the clean reducer stays green", () => {
    const claims = claimsAt(IAT);
    expect(
      offlineNeverDegradeViolations(
        makeModule({ reauthOnOfflineEdge: true }),
        claims
      ).length
    ).toBeGreaterThan(0);
    expect(offlineNeverDegradeViolations(makeModule(), claims)).toEqual([]);
  });

  test("a reducer that maps offline-expiry to SESSION_EXPIRED (not LOCAL_GRACE) reddens; the clean reducer stays green", () => {
    const claims = claimsAt(IAT);
    const mutant = makeModule({ degradeOfflineExpiry: true });
    expect(
      offlineNeverDegradeViolations(mutant, claims).length
    ).toBeGreaterThan(0);
    expect(offlineRegionViolations(mutant, claims).length).toBeGreaterThan(0);
    expect(offlineRegionViolations(makeModule(), claims)).toEqual([]);
  });
});

describe("the SESSION_EXPIRED-scope checker fires on a mis-scoped terminal", () => {
  test("a reducer that emits SESSION_EXPIRED on a successful refresh reddens; the clean reducer stays green", () => {
    const claims = claimsAt(IAT);
    expect(
      sessionExpiredScopeViolations(
        makeModule({ expireOnOkRefresh: true }),
        claims
      ).length
    ).toBeGreaterThan(0);
    expect(sessionExpiredScopeViolations(makeModule(), claims)).toEqual([]);
  });
});

describe("the ceiling checker fires on a device-time or skew-extended ceiling", () => {
  test("a ceiling computed from now+8h (device time) never exits LOCAL_GRACE and reddens; the iat-derived ceiling stays green", () => {
    expect(
      ceilingViolations(makeModule({ ceilingFromDeviceTime: true }), IAT).length
    ).toBeGreaterThan(0);
    expect(ceilingViolations(makeModule(), IAT)).toEqual([]);
  });

  test("applying the skew slack to the ceiling lets a just-past-ceiling now re-enter LOCAL_GRACE and reddens; the clean reducer stays green", () => {
    expect(
      ceilingViolations(makeModule({ skewOnCeiling: true }), IAT).length
    ).toBeGreaterThan(0);
    expect(ceilingViolations(makeModule(), IAT)).toEqual([]);
  });
});

describe("the skew-bound checker fires on a widened skew", () => {
  test("a skew bound wider than IDLE_TIMEOUT_MS reddens; a fixed ≤-idle skew stays green", () => {
    expect(
      skewBoundViolations(makeModule({ skewMs: THIRTY_MIN_MS + 1 })).length
    ).toBeGreaterThan(0);
    expect(skewBoundViolations(makeModule())).toEqual([]);
  });
});

describe("the data-path checker fires on an offline-blocking guard", () => {
  test("a guard that blocks writes in LOCAL_GRACE reddens the data-path check; the clean guard stays green", () => {
    expect(
      dataPathViolations(makeModule({ blockLocalGrace: true })).length
    ).toBeGreaterThan(0);
    expect(dataPathViolations(makeModule())).toEqual([]);
  });
});

describe("the force-refresh checker fires on a reducer that trusts a past-ceiling token", () => {
  test("a reducer that never forces a refresh past the ceiling reddens; the clean reducer stays green", () => {
    const claims = claimsAt(IAT);
    expect(
      mustForceRefreshViolations(
        makeModule({ neverForceRefresh: true }),
        claims
      ).length
    ).toBeGreaterThan(0);
    expect(mustForceRefreshViolations(makeModule(), claims)).toEqual([]);
  });
});

describe("the no-real-timers detector resists comments and fires on a real clock read", () => {
  test("a planted Date.now() in code reddens; a Date.now mentioned only in a comment does NOT redden; timer-free source stays green", () => {
    expect(findRealTimeReads("const t = Date.now();").length).toBeGreaterThan(
      0
    );
    expect(
      findRealTimeReads("// never call Date.now here\nconst x = 1;")
    ).toEqual([]);
    expect(
      findRealTimeReads(
        "const state = evaluateSession({ claims, now, online });"
      )
    ).toEqual([]);
  });
});
