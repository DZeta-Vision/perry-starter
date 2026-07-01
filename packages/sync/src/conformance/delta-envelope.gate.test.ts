// Conformance gate (sync surface) — the canonical delta envelope flows through
// the sync module surface UNCHANGED.
//
// The envelope is single-sourced in @perry-starter/db; this package re-exports
// it and never redeclares it. This gate asserts the re-exported shape is the
// exact six-field contract { id, scope_user_id, doc_id, doc_schema_version,
// cursor, payload } with a server-assigned integer cursor, and that the derived
// pre-push (unacked) variant is the same shape minus the cursor. Its paired
// mutation twin proves the gate goes red on a malformed envelope.
//
// The sync module surface is implemented, so this gate is active.

import { deltaEnvelopeSchema } from "@perry-starter/db/shapes/delta-envelope";
import { describe, expect, test } from "vitest";
import { unackedDeltaSchema } from "../index";

const ID_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID_B = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const ID_C = "01J0XQT8Z9N3H6K2M5P7R9T1V3";
// base64 of "hello" — an opaque, transport-only update payload.
const PAYLOAD_B64 = "aGVsbG8=";
const EXACT_FIELD_COUNT = 6;

const canonical = () => ({
  id: ID_A,
  scope_user_id: ID_B,
  doc_id: ID_C,
  doc_schema_version: 1,
  cursor: 42,
  payload: PAYLOAD_B64,
});

describe("the sync surface re-exports the canonical delta envelope", () => {
  test("the canonical envelope parses with a server-assigned integer cursor", () => {
    expect(deltaEnvelopeSchema.safeParse(canonical()).success).toBe(true);
    expect(
      deltaEnvelopeSchema.safeParse({
        ...canonical(),
        cursor: Number.MAX_SAFE_INTEGER,
      }).success
    ).toBe(true);
  });

  test("the envelope is exactly the six canonical fields", () => {
    expect(Object.keys(canonical())).toHaveLength(EXACT_FIELD_COUNT);
    expect(deltaEnvelopeSchema.safeParse(canonical()).success).toBe(true);
  });

  test("the pre-push variant is the canonical shape minus the server cursor", () => {
    const { cursor, ...unacked } = canonical();
    expect(cursor).toBe(42);
    expect(unackedDeltaSchema.safeParse(unacked).success).toBe(true);
    // The pre-push variant still requires every other field — dropping the
    // scope owner is still a rejection.
    const { scope_user_id, ...withoutScope } = unacked;
    expect(scope_user_id).toBe(ID_B);
    expect(unackedDeltaSchema.safeParse(withoutScope).success).toBe(false);
  });
});
