// Mutation twin for collaboration-mode-routing.gate.test.ts. Proves the routing
// is genuinely single-sourced-or-fail and that the registry's immutability holds:
//   - resolving a collection that declared NO mode throws (no silent default
//     path) — a collection cannot be materialized without a declared mode;
//   - a runtime mutation attempt on the frozen registry does not inject a new
//     routable collection.
//
// RED PHASE: every test is skipped until the surface is implemented.

import { collaborationModeRegistry } from "@perry-starter/db/collaboration-mode";
import { describe, expect, test } from "vitest";
import { resolveCollaborationPath } from "../projection";

describe("collaboration routing is single-sourced-or-fail", () => {
  test("a collection that declared no collaboration mode cannot be routed (throws, no silent default)", () => {
    expect(() =>
      resolveCollaborationPath("not_a_registered_collection")
    ).toThrow();
  });

  test("a runtime mutation of the frozen registry does not create a routable collection", () => {
    expect(() =>
      Object.assign(collaborationModeRegistry, { injected: "collaborative" })
    ).toThrow();
    expect(() => resolveCollaborationPath("injected")).toThrow();
  });
});
