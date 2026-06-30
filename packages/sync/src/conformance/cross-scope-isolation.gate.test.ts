import { describe, expect, test } from "vitest";
import {
  DELTA_COPIES,
  type DeltaCopy,
  type PerimeterSession,
  resolveEnforcedScope,
  SYNC_LEGS,
  type SyncLeg,
} from "../isolation";

// Conformance gate — the cross-scope isolation perimeter is SERVER-DERIVED and
// total. Three invariants, each with an anti-vacuous twin in the paired
// mutation file:
//   1. The enforced scope is the session owner's id — a client-asserted scope in
//      the request body is ignored, so a forged scope cannot widen the perimeter.
//   2. The perimeter covers every copy of delta data (cloud log, local store,
//      materialized projection) — no copy is silently missed.
//   3. The perimeter applies on BOTH the push and the pull leg — isolation is
//      never one-way.

// A scope is server-derived iff the resolver returns the session owner's id
// regardless of what scope the request body asserted (including a forged scope
// that names another owner). Replicated verbatim in the mutation twin so the
// predicate itself is proven to discriminate.
const isServerDerived = (
  resolve: (session: PerimeterSession, asserted?: string) => string,
  session: PerimeterSession,
  forgedScope: string
): boolean =>
  resolve(session, undefined) === session.user.id &&
  resolve(session, forgedScope) === session.user.id;

const coversEveryCopy = (copies: readonly DeltaCopy[]): boolean => {
  const required: readonly DeltaCopy[] = [
    "cloud-log",
    "local-store",
    "materialized-projection",
  ];
  return required.every((copy) => copies.includes(copy));
};

const coversBothLegs = (legs: readonly SyncLeg[]): boolean =>
  legs.includes("push") && legs.includes("pull");

const SESSION_A: PerimeterSession = {
  user: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
};
const OTHER_OWNER_SCOPE = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

describe("the cross-scope isolation perimeter is server-derived and total", () => {
  test("the enforced scope is the session owner's id, never the client-asserted scope", () => {
    expect(
      isServerDerived(resolveEnforcedScope, SESSION_A, OTHER_OWNER_SCOPE)
    ).toBe(true);
  });

  test("a request asserting another owner's scope is reduced to the session owner's scope", () => {
    // The forged scope names a different owner; the enforced scope must remain
    // the session owner's id, so the forged value never leaks through.
    expect(resolveEnforcedScope(SESSION_A, OTHER_OWNER_SCOPE)).toBe(
      SESSION_A.user.id
    );
    expect(resolveEnforcedScope(SESSION_A, OTHER_OWNER_SCOPE)).not.toBe(
      OTHER_OWNER_SCOPE
    );
  });

  test("the perimeter covers the cloud log, the local store, and the materialized projection", () => {
    expect(coversEveryCopy(DELTA_COPIES)).toBe(true);
  });

  test("the perimeter applies on both the push and the pull leg", () => {
    expect(coversBothLegs(SYNC_LEGS)).toBe(true);
  });
});
