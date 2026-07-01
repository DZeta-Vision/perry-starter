// Conformance gate — the projection materializer routes a collection onto its
// convergence path using the SINGLE-SOURCED, immutable collaborationMode registry
// in @perry-starter/db (re-used here, never redeclared). Private/non-mergeable
// collections take the last-write-wins path; collaborative collections take the
// Loro causal-merge path. The reference `documents` collection is private.
//
// RED PHASE: every test is skipped until the surface is implemented.

import {
  collaborationModeRegistry,
  collaborationModeSchema,
} from "@perry-starter/db/collaboration-mode";
import { describe, expect, test } from "vitest";
import {
  collaborationPathForMode,
  resolveCollaborationPath,
} from "../projection";

describe("the materializer routes by the single-sourced collaborationMode registry", () => {
  test("the reference documents collection routes to the last-write-wins path (private)", () => {
    expect(collaborationModeRegistry.documents).toBe("private");
    expect(resolveCollaborationPath("documents")).toBe("lww");
  });

  test("every registered collection resolves to exactly one valid path from a valid mode", () => {
    for (const [collection, mode] of Object.entries(
      collaborationModeRegistry
    )) {
      expect(collaborationModeSchema.safeParse(mode).success).toBe(true);
      expect(["lww", "loro-merge"]).toContain(
        resolveCollaborationPath(collection)
      );
    }
  });

  test("the private mode maps to last-write-wins and collaborative maps to Loro causal merge", () => {
    expect(collaborationPathForMode("private")).toBe("lww");
    expect(collaborationPathForMode("collaborative")).toBe("loro-merge");
  });

  test("collaborative is the only mode that selects the Loro merge path", () => {
    // Loro causal merge is used ONLY for collaborative collections; private
    // never routes to the Loro path.
    expect(collaborationPathForMode("collaborative")).toBe("loro-merge");
    expect(collaborationPathForMode("private")).not.toBe("loro-merge");
  });
});
