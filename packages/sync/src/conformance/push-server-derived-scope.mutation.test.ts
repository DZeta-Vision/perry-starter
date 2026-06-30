import { describe, expect, test } from "vitest";

// Mutation twin for push-server-derived-scope.gate.test.ts — the anti-vacuous
// proof that the fail-closed discriminator fires.
//
// The fail-closed contract is replicated here as a pure predicate and fed
// deliberately-bad and clean reference implementations: a "stamp" that falls back
// to the client scope when the enforced scope is absent is flagged; a strict
// stamp that rejects an absent scope and returns only the enforced one stays
// green. If the discriminator ever stopped distinguishing the two, an assertion
// below would flip and the twin would fail.

const ENFORCED_SCOPE = "scope-server-derived-owner";
const CLIENT_FORGED_SCOPE = "scope-client-forged-other";

type Stamp = (enforced: string, clientScope: string) => string;

// A scope-stamping rule is fail-closed iff it (a) REJECTS an absent enforced
// scope (never silently defaults) and (b) returns exactly the enforced scope —
// never the client's — when one is present.
const isFailClosed = (stamp: Stamp): boolean => {
  let rejectedAbsentScope = false;
  try {
    stamp("", CLIENT_FORGED_SCOPE);
  } catch {
    rejectedAbsentScope = true;
  }
  const stamped = stamp(ENFORCED_SCOPE, CLIENT_FORGED_SCOPE);
  const stampsEnforced = stamped === ENFORCED_SCOPE;
  const leaksClientScope = stamped === CLIENT_FORGED_SCOPE;
  return rejectedAbsentScope && stampsEnforced && !leaksClientScope;
};

// Correct: rejects an absent enforced scope, and stamps only the enforced one.
const strictStamp: Stamp = (enforced) => {
  if (!enforced) {
    throw new Error("missing enforced scope");
  }
  return enforced;
};

// Broken: silently falls back to the client-supplied scope when the enforced
// scope is absent — exactly the fail-open the perimeter must foreclose.
const permissiveStamp: Stamp = (enforced, clientScope) =>
  enforced || clientScope;

describe("the fail-closed discriminator fires on a perimeter that trusts the client scope", () => {
  test("a stamp that falls back to the client scope when the enforced scope is absent is flagged", () => {
    expect(isFailClosed(permissiveStamp)).toBe(false);
  });

  test("a strict stamp that rejects an absent scope and stamps only the enforced one stays green (not always-red)", () => {
    expect(isFailClosed(strictStamp)).toBe(true);
  });
});
