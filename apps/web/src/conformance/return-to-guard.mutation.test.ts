import { describe, expect, test } from "vitest";

// Mutation twin for the open-redirect guard gate. A NAIVE guard — missing the
// "//" protocol-relative check and the in-app allowlist — is re-declared locally
// (twins never import the gate's validator) and shown to ACCEPT inputs the real
// guard must reject. That proves the gate's malicious-rejection legs would go red
// against a broken implementation; the control proves the twin is not always-red.

const DEFAULT_ROUTE = "/";

// The regression the gate must catch: "starts with a slash" is not enough.
const naiveReturnTo = (value: string): string =>
  value.startsWith("/") ? value : DEFAULT_ROUTE;

describe("a naive returnTo guard is detectably broken (the gate would redden)", () => {
  test("the naive guard lets a protocol-relative off-origin value through unchanged", () => {
    expect(naiveReturnTo("//evil.example")).toBe("//evil.example");
    expect(naiveReturnTo("//evil.example")).not.toBe(DEFAULT_ROUTE);
  });

  test("the naive guard lets an unknown, non-in-app path through unchanged", () => {
    expect(naiveReturnTo("/not-an-app-route-zzz")).toBe(
      "/not-an-app-route-zzz"
    );
  });

  test("the naive guard preserves a valid in-app path too (so the twin is not always-red)", () => {
    expect(naiveReturnTo("/dashboard")).toBe("/dashboard");
  });
});
