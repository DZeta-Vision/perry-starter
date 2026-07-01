import { expect, test } from "vitest";
import { assertLocaleParity } from "../proxy";

// Mutation twin for locale-parity.gate.test.ts — the anti-vacuous proof.
//
// The gate trusts assertLocaleParity: both legs must have received the SAME
// resolved account locale. This twin proves the check goes red when one leg
// defaulted (e.g. to "en") while the other read the account value ("fr"), and
// stays green when they agree.

test("a leg that defaulted while the other read the account value fails parity", () => {
  // local defaulted to "en" while the account locale (and the cloud leg) is "fr".
  expect(assertLocaleParity(["fr", "en"], "fr")).toBe(false);
});

test("legs that both received the account value pass parity (not always-red)", () => {
  expect(assertLocaleParity(["fr", "fr"], "fr")).toBe(true);
});

test("an empty leg set is not vacuously true", () => {
  expect(assertLocaleParity([], "fr")).toBe(false);
});
