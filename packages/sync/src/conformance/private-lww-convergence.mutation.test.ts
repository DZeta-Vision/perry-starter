// Mutation twin for private-lww-convergence.gate.test.ts. Proves the LWW winner
// is keyed on the server cursor and NOTHING else — a tiebreak on the ULID
// (highest/lexical-max), on a device clock, or on array position would pick a
// DIFFERENT delta in the adversarial fixture below, and these assertions catch
// exactly that wrong implementation.
//
// RED PHASE: every test is skipped until the surface is implemented.

import type { DeltaEnvelope } from "@perry-starter/db/shapes/delta-envelope";
import { describe, expect, test } from "vitest";
import { selectPrivateLwwWinner } from "../projection";

const DOC_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SCOPE_ID = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const EARLY_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const LATER_ULID = "01J0XQT8Z9N3H6K2M5P7R9T1V3";
const MID_ULID = "01HA0000000000000000000000";
const PAYLOAD_B64 = "aGVsbG8=";

const delta = (overrides: Partial<DeltaEnvelope>): DeltaEnvelope => ({
  id: EARLY_ULID,
  scope_user_id: SCOPE_ID,
  doc_id: DOC_ID,
  doc_schema_version: 1,
  cursor: 1,
  payload: PAYLOAD_B64,
  ...overrides,
});

describe("the LWW winner is the max cursor, never the max ULID / clock / array position", () => {
  test("the highest-ULID delta does NOT win when it has a lower cursor", () => {
    // Adversarial: MAX(cursor) and MAX(ULID) point at DIFFERENT deltas, and the
    // MAX(cursor) delta is neither first nor last in the array.
    const winnerByCursor = delta({ id: EARLY_ULID, cursor: 20 });
    const highestUlidLowCursor = delta({ id: LATER_ULID, cursor: 7 });
    const deltas = [
      highestUlidLowCursor,
      winnerByCursor,
      delta({ id: MID_ULID, cursor: 3 }),
    ];

    const lexicalMaxUlid = [...deltas].sort((a, b) =>
      a.id < b.id ? 1 : -1
    )[0];
    expect(lexicalMaxUlid?.id).toBe(LATER_ULID);

    const winner = selectPrivateLwwWinner(deltas);
    expect(winner.id).toBe(EARLY_ULID);
    expect(winner.cursor).toBe(20);
    // A ULID-tiebreak implementation would return LATER_ULID — it must not.
    expect(winner.id).not.toBe(LATER_ULID);
  });

  test("the last-appended delta does NOT win when an earlier one has a higher cursor", () => {
    // An array-position ("last wins") implementation would return cursor 2.
    const deltas = [
      delta({ id: EARLY_ULID, cursor: 15 }),
      delta({ id: LATER_ULID, cursor: 2 }),
    ];
    expect(selectPrivateLwwWinner(deltas).cursor).toBe(15);
    expect(selectPrivateLwwWinner(deltas).cursor).not.toBe(2);
  });
});
