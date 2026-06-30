import { describe, expect, test } from "vitest";

import { avatarInitials, FALLBACK_INITIAL } from "@/lib/initials";

// The initials-avatar derivation gate. The populated case (real initials) is
// paired with the fallback chain (single part, email initial, defined sentinel)
// so the helper is provably non-vacuous: it is neither always-fallback nor ever
// blank. The mutation twin proves an always-fallback helper would redden this.

describe("avatar initials derive from name parts with a defined, never-blank fallback", () => {
  test("a populated given/family name yields the two-letter initials (locale-stable for fr/en)", () => {
    expect(avatarInitials({ given_name: "Marie", family_name: "Curie" })).toBe(
      "MC"
    );
    expect(
      avatarInitials({
        given_name: "marie",
        family_name: "curie",
        locale: "fr",
      })
    ).toBe("MC");
  });

  test("a single present name part stands alone", () => {
    expect(avatarInitials({ given_name: "Ada" })).toBe("A");
    expect(avatarInitials({ family_name: "Lovelace" })).toBe("L");
  });

  test("with no name parts the email initial is used (never blank)", () => {
    expect(avatarInitials({ email: "z@b.test" })).toBe("Z");
  });

  test("with nothing usable the defined sentinel is returned, never an empty string", () => {
    expect(avatarInitials({})).toBe(FALLBACK_INITIAL);
    expect(avatarInitials({ given_name: "", family_name: "", email: "" })).toBe(
      FALLBACK_INITIAL
    );
    expect(FALLBACK_INITIAL.length).toBeGreaterThan(0);
  });
});
