// Acceptance suite — delta envelope canonical shape.
//
// The cursor must be a server-assigned integer, never a client clock or ULID: a
// ULID-as-cursor silently drops a causally-later op that minted a SMALLER ULID
// under offline/concurrent writers. `scope_user_id` is always required.
//
// The canonical Zod shape is imported dynamically so the suite stays portable;
// top-level imports are limited to vitest.

import { describe, expect, test } from "vitest";

// Valid 26-char Crockford-base32 ULIDs (first char 0-7) for canonical fixtures.
const ID_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID_B = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const ID_C = "01J0XQT8Z9N3H6K2M5P7R9T1V3";

// base64 "hello" — an opaque, transport-only update payload.
const PAYLOAD_B64 = "aGVsbG8=";

const canonicalEnvelope = () => ({
  id: ID_A,
  scope_user_id: ID_B,
  doc_id: ID_C,
  doc_schema_version: 1,
  cursor: 42,
  payload: PAYLOAD_B64,
});

const importEnvelope = async () => {
  const mod = await import("@perry-starter/db/shapes/delta-envelope");
  return mod.deltaEnvelopeSchema;
};

describe("delta envelope canonical shape", () => {
  test("the canonical delta envelope parses and the cursor is a server-assigned integer", async () => {
    const deltaEnvelopeSchema = await importEnvelope();
    // The exact canonical shape parses, and an integer cursor (z.number().int())
    // is accepted — never a client clock or ULID.
    expect(deltaEnvelopeSchema.safeParse(canonicalEnvelope()).success).toBe(
      true
    );
    expect(
      deltaEnvelopeSchema.safeParse({
        ...canonicalEnvelope(),
        cursor: 9_007_199_254_740_991,
      }).success
    ).toBe(true);
  });

  test("a ULID string as the cursor is rejected (the causally-later-op drop bug)", async () => {
    const deltaEnvelopeSchema = await importEnvelope();
    expect(
      deltaEnvelopeSchema.safeParse({ ...canonicalEnvelope(), cursor: ID_A })
        .success
    ).toBe(false);
  });

  test("a float and an ISO-timestamp string cursor are rejected", async () => {
    const deltaEnvelopeSchema = await importEnvelope();
    expect(
      deltaEnvelopeSchema.safeParse({ ...canonicalEnvelope(), cursor: 1.5 })
        .success
    ).toBe(false);
    expect(
      deltaEnvelopeSchema.safeParse({
        ...canonicalEnvelope(),
        cursor: "2026-06-28T12:00:00.000Z",
      }).success
    ).toBe(false);
  });

  test("a missing cursor is rejected", async () => {
    const deltaEnvelopeSchema = await importEnvelope();
    const { cursor, ...withoutCursor } = canonicalEnvelope();
    expect(cursor).toBe(42);
    expect(deltaEnvelopeSchema.safeParse(withoutCursor).success).toBe(false);
  });

  test("a missing scope_user_id is rejected", async () => {
    const deltaEnvelopeSchema = await importEnvelope();
    const { scope_user_id, ...withoutScope } = canonicalEnvelope();
    expect(scope_user_id).toBe(ID_B);
    expect(deltaEnvelopeSchema.safeParse(withoutScope).success).toBe(false);
  });

  test("a drifted, renamed, or extra field is rejected (strictObject keyset)", async () => {
    const deltaEnvelopeSchema = await importEnvelope();
    // Extra key (strictObject rejects unknown keys).
    expect(
      deltaEnvelopeSchema.safeParse({
        ...canonicalEnvelope(),
        extra_field: "drift",
      }).success
    ).toBe(false);
    // Renamed required field — `doc_id` drifts to camelCase, leaving doc_id absent.
    const { doc_id, ...renamed } = canonicalEnvelope();
    expect(doc_id).toBe(ID_C);
    expect(
      deltaEnvelopeSchema.safeParse({ ...renamed, docId: ID_C }).success
    ).toBe(false);
  });
});
