// Acceptance — the per-action step-up grant: fresh, single-use, short-TTL,
// server-verified, and bound to (session, action).
//
// A privileged mutation must never run on a stale or replayed re-auth. These tests
// drive the pure grant policy AND the server-side single-use store: a grant minted
// for action A replayed against B, reused after consumption, or presented past its
// TTL is rejected; a token the store never minted resolves to `missing` (so a client
// cannot satisfy step-up by asserting success); a prior success never satisfies a
// later or different action. The real re-auth credential is spike-gated; the grant
// state machine + security properties are proven here against the store with an
// injected clock — never faked green.

import {
  DANGEROUS_ACTIONS,
  evaluateStepUpFailure,
  isDangerousAction,
  mintStepUpGrant,
  STEP_UP_MAX_ATTEMPTS,
  STEP_UP_TTL_MS,
  verifyStepUpGrant,
} from "@perry-starter/auth/step-up";
import { createStepUpGrantStore } from "@perry-starter/auth/step-up-store";
import { describe, expect, test } from "vitest";

const T0 = 1_000_000;

describe("the step-up grant is fresh, single-use, short-TTL, and (session, action)-bound", () => {
  test("a fresh grant is minted with an unpredictable id, a 5-minute TTL, and unconsumed", () => {
    const a = mintStepUpGrant({
      action: "role.change",
      now: T0,
      sessionId: "s1",
    });
    const b = mintStepUpGrant({
      action: "role.change",
      now: T0,
      sessionId: "s1",
    });
    expect(a.id).not.toBe(b.id); // unpredictable, distinct per mint
    expect(a.expiresAt).toBe(T0 + STEP_UP_TTL_MS);
    expect(STEP_UP_TTL_MS).toBe(5 * 60 * 1000);
    expect(a.consumedAt).toBeUndefined();
  });

  test("verify binds to BOTH session and action, and enforces the TTL", () => {
    const grant = mintStepUpGrant({
      action: "role.change",
      now: T0,
      sessionId: "s1",
    });
    expect(
      verifyStepUpGrant({
        action: "role.change",
        grant,
        now: T0,
        sessionId: "s1",
      })
    ).toBe("ok");
    // Cross-action: the SAME grant for a different sensitive action is rejected.
    expect(
      verifyStepUpGrant({
        action: "invite.create",
        grant,
        now: T0,
        sessionId: "s1",
      })
    ).toBe("cross-action");
    // Cross-session: another session cannot use this grant.
    expect(
      verifyStepUpGrant({
        action: "role.change",
        grant,
        now: T0,
        sessionId: "s2",
      })
    ).toBe("cross-session");
    // Expired: at/after expiresAt.
    expect(
      verifyStepUpGrant({
        action: "role.change",
        grant,
        now: grant.expiresAt,
        sessionId: "s1",
      })
    ).toBe("expired");
    // Missing: no grant at all.
    expect(
      verifyStepUpGrant({
        action: "role.change",
        grant: undefined,
        now: T0,
        sessionId: "s1",
      })
    ).toBe("missing");
  });

  test("the store grants a fresh matching token exactly once (single-use)", () => {
    const store = createStepUpGrantStore();
    const token = store.issue({
      action: "role.change",
      now: T0,
      sessionId: "s1",
    });
    const first = store.verifyAndConsume({
      action: "role.change",
      now: T0,
      sessionId: "s1",
      token,
    });
    expect(first.granted).toBe(true);
    // Reuse after consumption is rejected — the grant is spent.
    const second = store.verifyAndConsume({
      action: "role.change",
      now: T0,
      sessionId: "s1",
      token,
    });
    expect(second.granted).toBe(false);
    expect(second.verdict).toBe("consumed");
  });

  test("a grant for action A is rejected when replayed against action B", () => {
    const store = createStepUpGrantStore();
    const token = store.issue({
      action: "role.change",
      now: T0,
      sessionId: "s1",
    });
    const replay = store.verifyAndConsume({
      action: "invite.create",
      now: T0,
      sessionId: "s1",
      token,
    });
    expect(replay.granted).toBe(false);
    expect(replay.verdict).toBe("cross-action");
  });

  test("a grant presented past its TTL is rejected", () => {
    const store = createStepUpGrantStore();
    const token = store.issue({
      action: "role.change",
      now: T0,
      sessionId: "s1",
    });
    const expired = store.verifyAndConsume({
      action: "role.change",
      now: T0 + STEP_UP_TTL_MS,
      sessionId: "s1",
      token,
    });
    expect(expired.granted).toBe(false);
    expect(expired.verdict).toBe("expired");
  });

  test("a token the store never minted resolves to missing (client cannot assert success)", () => {
    const store = createStepUpGrantStore();
    const fabricated = store.verifyAndConsume({
      action: "role.change",
      now: T0,
      sessionId: "s1",
      token: "client-fabricated-token",
    });
    expect(fabricated.granted).toBe(false);
    expect(fabricated.verdict).toBe("missing");
    // An absent token is likewise never a grant.
    const absent = store.verifyAndConsume({
      action: "role.change",
      now: T0,
      sessionId: "s1",
      token: undefined,
    });
    expect(absent.granted).toBe(false);
    expect(absent.verdict).toBe("missing");
  });

  test("a prior step-up success does NOT satisfy a later or different action", () => {
    const store = createStepUpGrantStore();
    const token = store.issue({
      action: "role.change",
      now: T0,
      sessionId: "s1",
    });
    expect(
      store.verifyAndConsume({
        action: "role.change",
        now: T0,
        sessionId: "s1",
        token,
      }).granted
    ).toBe(true);
    // A second dangerous action needs its OWN fresh grant — the spent token cannot
    // carry over.
    expect(
      store.verifyAndConsume({
        action: "invite.create",
        now: T0,
        sessionId: "s1",
        token,
      }).granted
    ).toBe(false);
  });

  test("fail-twice aborts the action (never the session): the second failure flags aborted", () => {
    const store = createStepUpGrantStore();
    const first = store.verifyAndConsume({
      action: "role.change",
      now: T0,
      sessionId: "s1",
      token: "bad",
    });
    expect(first.granted).toBe(false);
    expect(first.aborted).toBe(false);
    const second = store.verifyAndConsume({
      action: "role.change",
      now: T0,
      sessionId: "s1",
      token: "bad-again",
    });
    expect(second.granted).toBe(false);
    expect(second.aborted).toBe(true);
    expect(evaluateStepUpFailure({ failureCount: STEP_UP_MAX_ATTEMPTS })).toBe(
      "abort-action"
    );
  });

  test("the dangerous-action vocabulary includes role change + invitation creation and the reserved future set", () => {
    expect(DANGEROUS_ACTIONS).toContain("role.change");
    expect(DANGEROUS_ACTIONS).toContain("invite.create");
    expect(DANGEROUS_ACTIONS).toContain("user.ban");
    expect(DANGEROUS_ACTIONS).toContain("user.impersonate");
    expect(isDangerousAction("role.change")).toBe(true);
    expect(isDangerousAction("documents.read")).toBe(false);
  });
});
