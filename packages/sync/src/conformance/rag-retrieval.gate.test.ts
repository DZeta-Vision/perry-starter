import type { DocumentProjection } from "@perry-starter/db/shapes/document-projection";
import { expect, test } from "vitest";
import {
  assertColumnOwnedBy,
  BROWSER_PROJECTION_WRITER,
  registerProjectionWriter,
} from "../projection";
import {
  buildKnnRetrievalSql,
  EMBEDDING_DIM,
  fillEmbedding,
  isIndexBackedKeysetRead,
} from "../rag";

// Conformance gate — RAG retrieval over the local document-embedding projection.
//
// Proves the retrieval query is a SurrealDB-native HNSW KNN (index-backed via the
// `<|K,EF|>` operator), keyset-bounded by the server-derived scope, and free of
// OFFSET / full-scan; that the single projection writer fills the embedding by
// CALLING the AI-seam embed interface (the AI seam never writes the table); and
// that a second writer (the AI seam) may not register. The twin proves each check
// goes red on an OFFSET read, a bad embedding, and a second-writer registration.

const SCOPE_BIND = /scope_user_id\s*=\s*\$scope/;
const ULID_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ULID_B = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

const baseProjection: DocumentProjection = {
  doc_id: ULID_A,
  scope_user_id: ULID_B,
  title: "Sync design",
  body_preview: "The delta log converges by highest server cursor.",
  embedding: null,
  embedding_model: "unembedded",
  updated_cursor: 7,
};

const stubEmbedFn = (_text: string) =>
  Promise.resolve({
    model: "stub-embed-v0",
    vector: Array.from({ length: EMBEDDING_DIM }, (_unused, i) => i / 10),
  });

test("the RAG retrieval query is an index-backed, keyset-bounded HNSW KNN with no OFFSET", () => {
  const query = buildKnnRetrievalSql(5);
  expect(isIndexBackedKeysetRead(query)).toBe(true);
  expect(query).toContain("<|5,");
  expect(query).toMatch(SCOPE_BIND);
  expect(query.toLowerCase()).not.toContain("offset");
});

test("the projection writer fills the embedding by calling the AI-seam embed interface, validated and model-tagged", async () => {
  const filled = await fillEmbedding(baseProjection, stubEmbedFn);
  expect(filled.embedding).toHaveLength(EMBEDDING_DIM);
  expect(filled.embedding_model).toBe("stub-embed-v0");
  // The sentinel "unembedded" tag is replaced with a real model tag.
  expect(filled.embedding_model).not.toBe("unembedded");
});

test("the AI seam computes the embedding but may not register as a second projection writer", () => {
  registerProjectionWriter(BROWSER_PROJECTION_WRITER);
  // The browser (single writer) owns the embedding column.
  expect(() =>
    assertColumnOwnedBy("embedding", BROWSER_PROJECTION_WRITER)
  ).not.toThrow();
  // A second writer — e.g. the AI seam — writing the table is rejected.
  expect(() => registerProjectionWriter("ai-seam")).toThrow();
  expect(() => assertColumnOwnedBy("embedding", "ai-seam")).toThrow();
});
