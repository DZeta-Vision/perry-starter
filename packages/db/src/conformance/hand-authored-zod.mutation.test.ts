import { describe, expect, test } from "vitest";

const isRuntimeValidator = (candidate: unknown): boolean => {
  const shape = candidate as { parse?: unknown; safeParse?: unknown } | null;
  return (
    typeof shape?.parse === "function" && typeof shape?.safeParse === "function"
  );
};

describe("the runtime-validator assertion rejects non-Zod stand-ins", () => {
  test("a bare object literal (TypeScript-interface stand-in) is rejected", () => {
    const interfaceStandIn = { doc_id: "string", scope_user_id: "string" };
    expect(isRuntimeValidator(interfaceStandIn)).toBe(false);
  });

  test("an empty object and a null candidate are rejected", () => {
    expect(isRuntimeValidator({})).toBe(false);
    expect(isRuntimeValidator(null)).toBe(false);
  });
});
