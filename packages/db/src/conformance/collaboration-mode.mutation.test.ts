import { describe, expect, test } from "vitest";
import {
  collaborationModeRegistry,
  collaborationModeSchema,
} from "../collaboration-mode";

describe("collaboration mode registry rejects known-bad input", () => {
  test("the enum rejects an invalid mode", () => {
    expect(collaborationModeSchema.safeParse("public").success).toBe(false);
    expect(collaborationModeSchema.safeParse("shared").success).toBe(false);
  });

  test("a runtime mutation attempt on the frozen registry does not change it", () => {
    expect(() =>
      Object.assign(collaborationModeRegistry, { injected_mode: "private" })
    ).toThrow();
    expect(
      (collaborationModeRegistry as Record<string, unknown>).injected_mode
    ).toBeUndefined();
  });
});
