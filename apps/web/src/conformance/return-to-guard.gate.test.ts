import { describe, expect, test } from "vitest";

import { DEFAULT_ROUTE, safeReturnTo } from "@/lib/return-to";

// The open-redirect guard gate. The control (a valid same-origin in-app path is
// preserved) is paired with the negative legs (every external / scheme-bearing /
// protocol-relative / unknown-path value is rejected to the default route), so
// the guard is provably non-vacuous: it neither sends everything to the default
// route nor accepts an off-origin destination. The mutation twin proves a broken
// guard would redden this gate.

const MALICIOUS_RETURN_TOS = [
  "https://evil.example/x",
  "//evil.example",
  "javascript:alert(1)",
  "data:text/html,<script>1</script>",
  "/not-an-app-route-zzz",
  "/\\evil.example",
  "mailto:a@b.test",
  "",
];

describe("the returnTo guard preserves same-origin in-app paths and rejects everything else", () => {
  test("a valid in-app same-origin path is preserved (control)", () => {
    expect(safeReturnTo("/dashboard")).toBe("/dashboard");
    expect(safeReturnTo("/settings/security")).toBe("/settings/security");
  });

  test("a valid in-app path keeps its query string", () => {
    expect(safeReturnTo("/dashboard?tab=docs")).toBe("/dashboard?tab=docs");
  });

  test.each(
    MALICIOUS_RETURN_TOS
  )("rejects the unsafe returnTo %j to the default route", (value) => {
    expect(safeReturnTo(value)).toBe(DEFAULT_ROUTE);
  });

  test("a non-string returnTo is rejected to the default route", () => {
    expect(safeReturnTo(null)).toBe(DEFAULT_ROUTE);
    expect(safeReturnTo(undefined)).toBe(DEFAULT_ROUTE);
    expect(safeReturnTo(42)).toBe(DEFAULT_ROUTE);
  });
});
