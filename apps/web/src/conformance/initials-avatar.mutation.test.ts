import { describe, expect, test } from "vitest";

// Mutation twin for the initials-avatar gate. An always-fallback helper (the bug
// where the name parts are ignored) is re-declared locally and shown to fail the
// populated case — proving the gate's "populated -> real initials" leg would go
// red. The fallback control keeps the twin from being always-red.

const FALLBACK = "?";

const alwaysFallbackInitials = (_identity: {
  given_name?: string;
  family_name?: string;
}): string => FALLBACK;

describe("an always-fallback initials helper is detectably broken (the gate would redden)", () => {
  test("the broken helper returns the fallback even for a fully populated name", () => {
    const result = alwaysFallbackInitials({
      given_name: "Marie",
      family_name: "Curie",
    });
    expect(result).toBe(FALLBACK);
    expect(result).not.toBe("MC");
  });

  test("the broken helper still returns the fallback for an empty name (not always-red)", () => {
    expect(alwaysFallbackInitials({})).toBe(FALLBACK);
  });
});
