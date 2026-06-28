import { describe, expect, test } from "vitest";
import {
  collaborationModeRegistry,
  collaborationModeSchema,
} from "../collaboration-mode";

describe("collaboration mode registry conformance", () => {
  test("every registry entry is a valid mode and the documents collection is registered", () => {
    expect(collaborationModeRegistry.documents).toBeDefined();
    for (const mode of Object.values(collaborationModeRegistry)) {
      expect(collaborationModeSchema.safeParse(mode).success).toBe(true);
    }
  });

  test("both valid modes are accepted by the enum", () => {
    expect(collaborationModeSchema.safeParse("private").success).toBe(true);
    expect(collaborationModeSchema.safeParse("collaborative").success).toBe(
      true
    );
  });

  test("the registry is frozen at runtime", () => {
    expect(Object.isFrozen(collaborationModeRegistry)).toBe(true);
  });

  test("registry entries are readonly at compile time", () => {
    const attemptReassign = (): void => {
      // @ts-expect-error registry values are readonly; reassignment must not compile
      collaborationModeRegistry.documents = "collaborative";
    };
    // The reassignment above never executes; this asserts the guard is present.
    expect(attemptReassign).toBeTypeOf("function");
  });
});
