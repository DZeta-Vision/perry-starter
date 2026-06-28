import { describe, expect, test } from "vitest";
import { documentsEntitySchema } from "../documents";

const DOC_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SCOPE_ID = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

const generic = () => ({
  doc_id: DOC_ID,
  scope_user_id: SCOPE_ID,
  title: "Untitled",
  body_preview: "A generic document body preview.",
});

describe("generic documents reference entity", () => {
  test("the domain-neutral entity parses with generic snake_case fields", () => {
    expect(documentsEntitySchema.safeParse(generic()).success).toBe(true);
  });

  test("every projected field key is generic snake_case (no domain nouns)", () => {
    const keys = Object.keys(documentsEntitySchema.shape);
    expect(keys).toEqual(["doc_id", "scope_user_id", "title", "body_preview"]);
  });
});
