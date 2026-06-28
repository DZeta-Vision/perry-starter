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

describe("document projection canonical shape", () => {
  test("a model-tagged embedding and integer updated_cursor parse", () => {
    expect(documentProjectionSchema.safeParse(canonical()).success).toBe(true);
  });

  test("a not-yet-embedded projection (null embedding, tag present) parses", () => {
    expect(
      documentProjectionSchema.safeParse({ ...canonical(), embedding: null })
        .success
    ).toBe(true);
  });
});
