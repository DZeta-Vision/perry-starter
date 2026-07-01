import { describe, expect, test } from "vitest";
import type { DeltaCopy, PerimeterSession, SyncLeg } from "../isolation";

// Mutation twin for cross-scope-isolation.gate.test.ts — the anti-vacuous proof.
//
// The gate's three discriminators are replicated here and fed deliberately-bad
// reference implementations; the twin asserts each discriminator reddens, with a
// clean control proving it is not always-red. If a discriminator ever stopped
// distinguishing a broken perimeter from a correct one, the matching assertion
// below would flip and the twin would fail.

// --- Discriminator 1: server-derived scope (forged scope ignored) ---

const isServerDerived = (
  resolve: (session: PerimeterSession, asserted?: string) => string,
  session: PerimeterSession,
  forgedScope: string
): boolean =>
  resolve(session, undefined) === session.user.id &&
  resolve(session, forgedScope) === session.user.id;

// --- Discriminator 2: covers every copy of delta data ---

const coversEveryCopy = (copies: readonly DeltaCopy[]): boolean => {
  const required: readonly DeltaCopy[] = [
    "cloud-log",
    "local-store",
    "materialized-projection",
  ];
  return required.every((copy) => copies.includes(copy));
};

// --- Discriminator 3: covers both sync legs ---

const coversBothLegs = (legs: readonly SyncLeg[]): boolean =>
  legs.includes("push") && legs.includes("pull");

const SESSION: PerimeterSession = { user: { id: "owner-a" } };
const FORGED_SCOPE = "owner-b";

// A correct, server-derived resolver: the client-asserted scope is dropped.
const cleanResolve = (session: PerimeterSession): string => session.user.id;

// A broken resolver that TRUSTS the client-asserted scope when present — exactly
// the bug the perimeter must foreclose (a forged scope reads another owner).
const trustsClientResolve = (
  session: PerimeterSession,
  asserted?: string
): string => asserted ?? session.user.id;

describe("the server-derived discriminator fires on a perimeter that trusts the client scope", () => {
  test("a resolver that honours the client-asserted scope is flagged as not server-derived", () => {
    expect(isServerDerived(trustsClientResolve, SESSION, FORGED_SCOPE)).toBe(
      false
    );
  });

  test("a resolver that drops the client-asserted scope stays green (not always-red)", () => {
    expect(isServerDerived(cleanResolve, SESSION, FORGED_SCOPE)).toBe(true);
  });
});

describe("the copy-coverage discriminator fires on a perimeter that misses a copy", () => {
  test("a copy set missing the materialized projection is flagged", () => {
    expect(coversEveryCopy(["cloud-log", "local-store"])).toBe(false);
  });

  test("the full three-copy set stays green (not always-red)", () => {
    expect(
      coversEveryCopy(["cloud-log", "local-store", "materialized-projection"])
    ).toBe(true);
  });
});

describe("the leg-coverage discriminator fires on a one-way perimeter", () => {
  test("a push-only perimeter is flagged for not covering the pull leg", () => {
    expect(coversBothLegs(["push"])).toBe(false);
  });

  test("a perimeter covering both legs stays green (not always-red)", () => {
    expect(coversBothLegs(["push", "pull"])).toBe(true);
  });
});
