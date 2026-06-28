import { describe, expect, test } from "vitest";
import { documentProjectionSchema } from "../shapes/document-projection";

const DOC_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SCOPE_ID = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

const canonical = () => ({
  doc_id: DOC_ID,
  scope_user_id: SCOPE_ID,
  title: "Quarterly plan",
  body_preview: "First lines of the document body.",
  embedding: [0.12, -0.34, 0.56],
  embedding_model: "local-minilm-l6-v2",
  updated_cursor: 7,
});

describe("document projection rejects known-bad input", () => {
  test("a non-null embedding with an empty model tag is rejected (untagged vector)", () => {
    expect(
      documentProjectionSchema.safeParse({
        ...canonical(),
        embedding_model: "",
      }).success
    ).toBe(false);
  });

  test("a non-null embedding with a missing model tag is rejected", () => {
    const { embedding_model, ...untagged } = canonical();
    expect(embedding_model).toBe("local-minilm-l6-v2");
    expect(documentProjectionSchema.safeParse(untagged).success).toBe(false);
  });

  test("a missing updated_cursor is rejected", () => {
    const { updated_cursor, ...withoutCursor } = canonical();
    expect(updated_cursor).toBe(7);
    expect(documentProjectionSchema.safeParse(withoutCursor).success).toBe(
      false
    );
  });

  test("a float updated_cursor is rejected", () => {
    expect(
      documentProjectionSchema.safeParse({
        ...canonical(),
        updated_cursor: 7.5,
      }).success
    ).toBe(false);
  });

  test("a drifted (renamed required) field is rejected", () => {
    const { updated_cursor, ...renamed } = canonical();
    expect(updated_cursor).toBe(7);
    expect(
      documentProjectionSchema.safeParse({ ...renamed, updatedCursor: 7 })
        .success
    ).toBe(false);
  });
});
