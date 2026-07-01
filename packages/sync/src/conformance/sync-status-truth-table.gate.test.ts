// Conformance gate — the per-item sync verdict obeys a fixed input -> verdict
// truth table over exact integer cursors.
//
// The predicate is the single source of the verdict; this gate pins its output
// for the load-bearing boundary rows: the recency boundary (a < k, a == k,
// a > k), the pending-push case, the collaborative projection cases, and the
// rule that `syncing` strictly dominates `may-be-stale` when both could hold.
// Its paired mutation twin proves the boundary is load-bearing — an off-by-one
// predicate fails this table.
//
// RED PHASE: every test is skipped until the predicate is implemented.

import { describe, expect, test } from "vitest";
import type { SyncStatusInputs } from "../sync-status";
import { computeSyncStatus } from "../sync-status";

// A durable, recent, settled non-collaborative item. Individual tests override
// only the fields that matter, so each row is read as a delta from "up-to-date".
const settled = (): SyncStatusInputs => ({
  updated_cursor: 5,
  acked_cursor: 5,
  latest_known_server_cursor: 5,
  unacked_count: 0,
  active_pull: false,
  collaborative: false,
  projection_cursor: null,
});

describe("the sync verdict obeys the integer-cursor truth table", () => {
  test("up-to-date when the durable ack equals the latest known server cursor with no pending work (the a == k boundary)", () => {
    expect(computeSyncStatus(settled())).toBe("up-to-date");
  });

  test("up-to-date when the durable ack is past the latest known server cursor", () => {
    expect(
      computeSyncStatus({ ...settled(), latest_known_server_cursor: 4 })
    ).toBe("up-to-date");
  });

  test("may-be-stale when a remote writer advanced the server cursor past our durable ack", () => {
    // a < k with nothing pending: durable but not recent.
    expect(
      computeSyncStatus({ ...settled(), latest_known_server_cursor: 6 })
    ).toBe("may-be-stale");
  });

  test("syncing while a push is pending, even when the ack is behind the server cursor (syncing dominates may-be-stale)", () => {
    expect(
      computeSyncStatus({
        ...settled(),
        latest_known_server_cursor: 6,
        unacked_count: 2,
      })
    ).toBe("syncing");
  });

  test("syncing while a push is pending even when otherwise fully caught up", () => {
    expect(computeSyncStatus({ ...settled(), unacked_count: 3 })).toBe(
      "syncing"
    );
  });

  test("syncing while a pull is in flight and our ack is behind the server cursor", () => {
    expect(
      computeSyncStatus({
        ...settled(),
        latest_known_server_cursor: 9,
        active_pull: true,
      })
    ).toBe("syncing");
  });

  test("a collaborative item whose projection is behind its durable ack is syncing", () => {
    // m < a -> the projection has not caught up to durable work yet.
    expect(
      computeSyncStatus({
        ...settled(),
        collaborative: true,
        projection_cursor: 3,
      })
    ).toBe("syncing");
  });

  test("a collaborative item whose projection trails the latest known server cursor is may-be-stale", () => {
    // m >= a but m < k -> recency lag in the projection, nothing in flight.
    expect(
      computeSyncStatus({
        ...settled(),
        latest_known_server_cursor: 8,
        acked_cursor: 8,
        collaborative: true,
        projection_cursor: 6,
      })
    ).toBe("may-be-stale");
  });

  test("a collaborative item is up-to-date only when its projection is at or past the latest known server cursor", () => {
    expect(
      computeSyncStatus({
        ...settled(),
        collaborative: true,
        projection_cursor: 5,
      })
    ).toBe("up-to-date");
  });
});
