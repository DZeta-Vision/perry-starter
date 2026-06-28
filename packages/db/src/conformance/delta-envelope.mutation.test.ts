import { describe, expect, test } from "vitest";
import { deltaEnvelopeSchema } from "../shapes/delta-envelope";

const ID_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID_B = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const ID_C = "01J0XQT8Z9N3H6K2M5P7R9T1V3";
const PAYLOAD_B64 = "aGVsbG8=";

const canonical = () => ({
  id: ID_A,
  scope_user_id: ID_B,
  doc_id: ID_C,
  doc_schema_version: 1,
  cursor: 42,
  payload: PAYLOAD_B64,
});

describe("delta envelope rejects known-bad input", () => {
  test("a ULID string as the cursor is rejected (the causally-later-op drop bug)", () => {
    expect(
      deltaEnvelopeSchema.safeParse({ ...canonical(), cursor: ID_A }).success
    ).toBe(false);
  });

  test("a float and an ISO-timestamp string cursor are rejected", () => {
    expect(
      deltaEnvelopeSchema.safeParse({ ...canonical(), cursor: 1.5 }).success
    ).toBe(false);
    expect(
      deltaEnvelopeSchema.safeParse({
        ...canonical(),
        cursor: "2026-06-28T12:00:00.000Z",
      }).success
    ).toBe(false);
  });

  test("a missing cursor is rejected", () => {
    const { cursor, ...withoutCursor } = canonical();
    expect(cursor).toBe(42);
    expect(deltaEnvelopeSchema.safeParse(withoutCursor).success).toBe(false);
  });

  test("a missing scope_user_id is rejected", () => {
    const { scope_user_id, ...withoutScope } = canonical();
    expect(scope_user_id).toBe(ID_B);
    expect(deltaEnvelopeSchema.safeParse(withoutScope).success).toBe(false);
  });

  test("a drifted, renamed, or extra field is rejected", () => {
    expect(
      deltaEnvelopeSchema.safeParse({ ...canonical(), extra_field: "drift" })
        .success
    ).toBe(false);
    const { doc_id, ...renamed } = canonical();
    expect(doc_id).toBe(ID_C);
    expect(
      deltaEnvelopeSchema.safeParse({ ...renamed, docId: ID_C }).success
    ).toBe(false);
  });
});
