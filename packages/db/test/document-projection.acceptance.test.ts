// Acceptance suite — DocumentProjection canonical shape.
//
// The embedding is model-tagged (a non-empty model tag accompanies the vector)
// so one index never mixes embedding spaces; `updated_cursor` is an integer; one
// owning writer owns every column including the embedding.
//
// The shape is imported dynamically; top-level imports are limited to vitest.

import { describe, expect, test } from "vitest";

const DOC_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SCOPE_ID = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

// Canonical projection: generic snake_case fields + a MODEL-TAGGED embedding
// (a non-empty model tag accompanies the vector) + an integer updated_cursor.
const canonicalProjection = () => ({
  doc_id: DOC_ID,
  scope_user_id: SCOPE_ID,
  title: "Quarterly plan",
  body_preview: "First lines of the document body…",
  embedding: [0.12, -0.34, 0.56],
  embedding_model: "local-minilm-l6-v2",
  updated_cursor: 7,
});

const importProjection = async () => {
  const mod = await import("@perry-starter/db/shapes/document-projection");
  return mod.documentProjectionSchema;
};

describe("DocumentProjection canonical shape", () => {
  test("the canonical projection parses with a model-tagged embedding and integer updated_cursor", async () => {
    const documentProjectionSchema = await importProjection();
    // A model-tagged vector + integer cursor parse cleanly; a null embedding
    // (not-yet-embedded) with a tag is still valid.
    expect(
      documentProjectionSchema.safeParse(canonicalProjection()).success
    ).toBe(true);
    expect(
      documentProjectionSchema.safeParse({
        ...canonicalProjection(),
        embedding: null,
      }).success
    ).toBe(true);
  });

  test("a non-null embedding with a missing or empty model tag is rejected (untagged vector)", async () => {
    const documentProjectionSchema = await importProjection();
    // Empty model tag alongside a real vector — an untagged embedding.
    expect(
      documentProjectionSchema.safeParse({
        ...canonicalProjection(),
        embedding_model: "",
      }).success
    ).toBe(false);
    // Missing model tag entirely.
    const { embedding_model, ...untagged } = canonicalProjection();
    expect(embedding_model).toBe("local-minilm-l6-v2");
    expect(documentProjectionSchema.safeParse(untagged).success).toBe(false);
  });

  test("a missing updated_cursor is rejected", async () => {
    const documentProjectionSchema = await importProjection();
    const { updated_cursor, ...withoutCursor } = canonicalProjection();
    expect(updated_cursor).toBe(7);
    expect(documentProjectionSchema.safeParse(withoutCursor).success).toBe(
      false
    );
  });

  test("a float updated_cursor is rejected", async () => {
    const documentProjectionSchema = await importProjection();
    expect(
      documentProjectionSchema.safeParse({
        ...canonicalProjection(),
        updated_cursor: 7.5,
      }).success
    ).toBe(false);
  });

  test("a drifted field (renamed required field) is rejected", async () => {
    const documentProjectionSchema = await importProjection();
    const { updated_cursor, ...renamed } = canonicalProjection();
    expect(updated_cursor).toBe(7);
    // `updated_cursor` drifts to camelCase, leaving the required key absent.
    expect(
      documentProjectionSchema.safeParse({ ...renamed, updatedCursor: 7 })
        .success
    ).toBe(false);
  });
});
