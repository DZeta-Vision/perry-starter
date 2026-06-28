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

describe("generic documents entity rejects known-bad input", () => {
  test("an appended domain-coupled field is rejected (removable-by-construction)", () => {
    // Any field beyond the generic set is rejected, so a domain-coupled column
    // cannot be smuggled into the canonical entity.
    expect(
      documentsEntitySchema.safeParse({
        ...generic(),
        coupled_domain_field: "leak",
      }).success
    ).toBe(false);
  });

  test("a missing required field is rejected", () => {
    const { body_preview, ...withoutPreview } = generic();
    expect(body_preview).toBe("A generic document body preview.");
    expect(documentsEntitySchema.safeParse(withoutPreview).success).toBe(false);
  });
});
