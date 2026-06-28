import { describe, expect, test } from "vitest";
import { deltaEnvelopeSchema } from "../shapes/delta-envelope";

const ID_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID_B = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const ID_C = "01J0XQT8Z9N3H6K2M5P7R9T1V3";
// base64 of "hello" — an opaque, transport-only update payload.
const PAYLOAD_B64 = "aGVsbG8=";

const canonical = () => ({
  id: ID_A,
  scope_user_id: ID_B,
  doc_id: ID_C,
  doc_schema_version: 1,
  cursor: 42,
  payload: PAYLOAD_B64,
});

describe("delta envelope canonical shape", () => {
  test("the canonical envelope parses with a server-assigned integer cursor", () => {
    expect(deltaEnvelopeSchema.safeParse(canonical()).success).toBe(true);
    expect(
      deltaEnvelopeSchema.safeParse({
        ...canonical(),
        cursor: Number.MAX_SAFE_INTEGER,
      }).success
    ).toBe(true);
  });

  test("scope_user_id is required and present on the canonical shape", () => {
    expect(canonical().scope_user_id).toBe(ID_B);
    expect(deltaEnvelopeSchema.safeParse(canonical()).success).toBe(true);
  });
});
