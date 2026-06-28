// Acceptance suite — collaborationMode enum + immutable registry.
//
// The registry is the single source for each collection's materialization locus,
// so it must be frozen at runtime and reject unknown modes. The compile-time
// immutability proof (a readonly reassignment) is enforced separately by the
// type checker; this file covers the runtime freeze + enum-membership directions.

import { describe, expect, test } from "vitest";

const importCollaborationMode = async () => {
  const mod = await import("@perry-starter/db/collaboration-mode");
  return {
    collaborationModeRegistry: mod.collaborationModeRegistry,
    collaborationModeSchema: mod.collaborationModeSchema,
  };
};

describe("collaborationMode enum + immutable registry", () => {
  test("every registry entry is a valid collaborationMode and the documents collection has an entry", async () => {
    const { collaborationModeRegistry, collaborationModeSchema } =
      await importCollaborationMode();
    // The documents collection is registered.
    expect(collaborationModeRegistry.documents).toBeDefined();
    // Every declared mode validates against the enum ('private' | 'collaborative').
    for (const mode of Object.values(collaborationModeRegistry)) {
      expect(collaborationModeSchema.safeParse(mode).success).toBe(true);
    }
  });

  test("the registry is frozen at runtime (Object.isFrozen === true)", async () => {
    const { collaborationModeRegistry } = await importCollaborationMode();
    expect(Object.isFrozen(collaborationModeRegistry)).toBe(true);
  });

  test("the enum rejects an invalid mode ('public', 'shared')", async () => {
    const { collaborationModeSchema } = await importCollaborationMode();
    expect(collaborationModeSchema.safeParse("public").success).toBe(false);
    expect(collaborationModeSchema.safeParse("shared").success).toBe(false);
    // Both valid modes are accepted.
    expect(collaborationModeSchema.safeParse("private").success).toBe(true);
    expect(collaborationModeSchema.safeParse("collaborative").success).toBe(
      true
    );
  });

  test("a runtime mutation attempt on the frozen registry does not change it", async () => {
    const { collaborationModeRegistry } = await importCollaborationMode();
    // Adding a key to a frozen object throws in ESM strict mode; the value is
    // unchanged either way.
    expect(() =>
      Object.assign(collaborationModeRegistry, { injected_mode: "private" })
    ).toThrow();
    expect(collaborationModeRegistry.injected_mode).toBeUndefined();
  });
});
