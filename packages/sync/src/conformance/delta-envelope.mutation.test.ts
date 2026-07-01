// Mutation twin for delta-envelope.gate.test.ts — proves the sync-surface
// envelope gate goes RED on a malformed envelope. A divergent/malformed
// envelope reaching durability would corrupt the append-only log, so each
// known-bad shape must be rejected by the re-exported single-sourced schema.
//
// The sync module surface is implemented, so this gate is active.

import { deltaEnvelopeSchema } from "@perry-starter/db/shapes/delta-envelope";
import { describe, expect, test } from "vitest";

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

describe("the sync-surface envelope gate rejects a malformed envelope", () => {
  test("rejects an envelope whose cursor is a ULID (the causally-later-op drop bug)", () => {
    expect(
      deltaEnvelopeSchema.safeParse({ ...canonical(), cursor: ID_A }).success
    ).toBe(false);
  });

  test("rejects an envelope whose cursor is a float or an ISO timestamp", () => {
    expect(
      deltaEnvelopeSchema.safeParse({ ...canonical(), cursor: 1.5 }).success
    ).toBe(false);
    expect(
      deltaEnvelopeSchema.safeParse({
        ...canonical(),
        cursor: "2026-06-30T12:00:00.000Z",
      }).success
    ).toBe(false);
  });

  test("rejects an envelope that is missing the cursor", () => {
    const { cursor, ...withoutCursor } = canonical();
    expect(cursor).toBe(42);
    expect(deltaEnvelopeSchema.safeParse(withoutCursor).success).toBe(false);
  });

  test("rejects an envelope that is missing the scope owner", () => {
    const { scope_user_id, ...withoutScope } = canonical();
    expect(scope_user_id).toBe(ID_B);
    expect(deltaEnvelopeSchema.safeParse(withoutScope).success).toBe(false);
  });

  test("rejects an envelope carrying a drifted, renamed, or extra field", () => {
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
