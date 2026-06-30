// Conformance gate — private/non-mergeable last-write-wins convergence (D8).
//
// For a private doc, the deterministic LWW winner is the delta with the MAXIMUM
// server-assigned cursor for that doc_id. The single writer replays the doc's
// deltas in ASCENDING cursor order, so the highest cursor is applied last and
// wins. This is immune to client-clock skew and out-of-order offline ULID
// minting: a later (by device clock / higher ULID) op that landed at a LOWER
// cursor does NOT win. Private collections NEVER use Loro causal merge.
//
// RED PHASE: every test is skipped until the surface is implemented.

import type { DeltaEnvelope } from "@perry-starter/db/shapes/delta-envelope";
import { describe, expect, test } from "vitest";
import type { CrdtDoc } from "../projection";
import {
  materializeProjection,
  replayOrderByCursorAsc,
  selectPrivateLwwWinner,
} from "../projection";

const DOC_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SCOPE_ID = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
// "earlier" ULID (lower time prefix) vs "later" ULID (higher time prefix). A
// skewed/fast device clock mints a ULID with a LATER prefix; an offline writer
// can mint these out of order relative to the server cursor.
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

describe("private records converge by highest-server-cursor last-write-wins", () => {
  test("the winner for a doc is the delta with the maximum server cursor", () => {
    const deltas = [
      delta({ id: EARLY_ULID, cursor: 5 }),
      delta({ id: MID_ULID, cursor: 12 }),
      delta({ id: LATER_ULID, cursor: 9 }),
    ];
    expect(selectPrivateLwwWinner(deltas).cursor).toBe(12);
    expect(selectPrivateLwwWinner(deltas).id).toBe(MID_ULID);
  });

  test("a later op (higher ULID) that landed at a LOWER cursor does NOT win", () => {
    // LATER_ULID looks newer by clock/ULID order but was assigned a lower cursor
    // than EARLY_ULID — the highest cursor still wins, not the highest ULID.
    const deltas = [
      delta({ id: LATER_ULID, cursor: 4 }),
      delta({ id: EARLY_ULID, cursor: 8 }),
    ];
    const winner = selectPrivateLwwWinner(deltas);
    expect(winner.cursor).toBe(8);
    expect(winner.id).toBe(EARLY_ULID);
    expect(winner.id).not.toBe(LATER_ULID);
  });

  test("the replay order is ascending by cursor (highest applied last)", () => {
    const deltas = [
      delta({ id: MID_ULID, cursor: 9 }),
      delta({ id: EARLY_ULID, cursor: 3 }),
      delta({ id: LATER_ULID, cursor: 14 }),
    ];
    expect(replayOrderByCursorAsc(deltas).map((d) => d.cursor)).toEqual([
      3, 9, 14,
    ]);
  });

  test("the winner is invariant to input ordering (no reliance on array order)", () => {
    const forward = [
      delta({ id: EARLY_ULID, cursor: 8 }),
      delta({ id: LATER_ULID, cursor: 4 }),
    ];
    const reversed = [...forward].reverse();
    expect(selectPrivateLwwWinner(forward).id).toBe(
      selectPrivateLwwWinner(reversed).id
    );
    expect(selectPrivateLwwWinner(reversed).cursor).toBe(8);
  });

  test("materializing a private collection never feeds deltas into Loro", () => {
    let importCalls = 0;
    const spyDoc: CrdtDoc = {
      importDelta: () => {
        importCalls += 1;
      },
      toJSON: () => ({}),
    };
    materializeProjection({
      collection: "documents",
      deltas: [delta({ cursor: 1 }), delta({ id: MID_ULID, cursor: 2 })],
      crdtDoc: spyDoc,
      writerId: "browser",
    });
    expect(importCalls).toBe(0);
  });
});
