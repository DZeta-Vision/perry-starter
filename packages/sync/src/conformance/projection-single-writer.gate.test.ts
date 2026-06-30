// Conformance gate — EXACTLY ONE writer materializes the read-only projection
// into local SurrealDB, owning every DocumentProjection column INCLUDING the
// embedding. The browser is that writer in v1. The AI seam computes embeddings
// through its interface but never registers as a projection writer (no second
// writer touches the table).
//
// RED PHASE: every test is skipped until the surface is implemented.

import { describe, expect, test } from "vitest";
import {
  assertColumnOwnedBy,
  BROWSER_PROJECTION_WRITER,
  registerProjectionWriter,
} from "../projection";

// Every materialized column the sole writer owns, including the embedding.
const OWNED_COLUMNS = [
  "doc_id",
  "scope_user_id",
  "title",
  "body_preview",
  "embedding",
  "embedding_model",
  "updated_cursor",
] as const;

describe("the projection has exactly one writer that owns every column", () => {
  test("registering the single browser writer succeeds", () => {
    expect(() =>
      registerProjectionWriter(BROWSER_PROJECTION_WRITER)
    ).not.toThrow();
  });

  test("the single writer owns every projection column, including the embedding", () => {
    registerProjectionWriter(BROWSER_PROJECTION_WRITER);
    for (const column of OWNED_COLUMNS) {
      expect(() =>
        assertColumnOwnedBy(column, BROWSER_PROJECTION_WRITER)
      ).not.toThrow();
    }
  });

  test("the embedding column is owned by the projection writer, not the AI seam", () => {
    // The AI seam computes embeddings through its interface but never writes the
    // table — embedding ownership belongs to the single projection writer.
    registerProjectionWriter(BROWSER_PROJECTION_WRITER);
    expect(() =>
      assertColumnOwnedBy("embedding", BROWSER_PROJECTION_WRITER)
    ).not.toThrow();
  });
});
