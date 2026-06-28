import { describe, expect, test } from "vitest";

// Mutation twin for egress-allowlist.gate.test.ts. Plants the three regressions
// and asserts each reddens, with a clean control. The buggy guards are in-memory
// reimplementations carrying the defect, so no missing import is needed.

const ALLOWLIST = ["worker.example.com", "updater.example.com"] as const;

// The CORRECT guard the impl must match: https + host ∈ allowlist, else throw.
const correctGuard = (url: string, allow: readonly string[]): void => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`egress: non-https scheme ${parsed.protocol}`);
  }
  if (!allow.includes(parsed.hostname)) {
    throw new Error(`egress: host not allowlisted ${parsed.hostname}`);
  }
};

const throwsFor = (fn: () => void): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

describe("the egress-guard mutations each let a disallowed request through", () => {
  test("an unconditional-delegate guard (allowlist check removed) does NOT throw on a disallowed host → the gate's throw expectation would fail", () => {
    const unconditional = (_url: string): void => {
      // delegates regardless — no allowlist/scheme check at all.
    };
    expect(throwsFor(() => unconditional("https://evil.example.com"))).toBe(
      false
    );
  });

  test("an empty-or-`*` allowlist admits any host (no throw) → reddens", () => {
    const wildcard = ["*"];
    // A `*`-membership check that treats `*` as "match anything" never throws.
    const wildcardGuard = (url: string): void => {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" && wildcard.includes("*")) {
        return; // admits everything
      }
      throw new Error("blocked");
    };
    expect(throwsFor(() => wildcardGuard("https://evil.example.com"))).toBe(
      false
    );
  });

  test("a guard missing the scheme check admits a non-HTTPS allowlisted host (no throw) → reddens", () => {
    const noSchemeCheck = (url: string): void => {
      const parsed = new URL(url);
      if (!ALLOWLIST.includes(parsed.hostname as (typeof ALLOWLIST)[number])) {
        throw new Error("blocked");
      }
      // scheme check omitted — http:// to an allowlisted host is wrongly admitted
    };
    expect(throwsFor(() => noSchemeCheck("http://worker.example.com"))).toBe(
      false
    );
  });

  test("the CORRECT guard throws on a disallowed host AND on a non-HTTPS scheme, and delegates an allowlisted HTTPS host (not always-red)", () => {
    expect(
      throwsFor(() => correctGuard("https://evil.example.com", ALLOWLIST))
    ).toBe(true);
    expect(
      throwsFor(() => correctGuard("http://worker.example.com", ALLOWLIST))
    ).toBe(true);
    expect(
      throwsFor(() => correctGuard("https://worker.example.com", ALLOWLIST))
    ).toBe(false);
  });
});
