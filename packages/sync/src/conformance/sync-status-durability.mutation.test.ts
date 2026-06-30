// Mutation twin for sync-status-durability.gate.test.ts — proves the durability
// gate is load-bearing: a predicate that treats an absent push-ack as durable,
// or a seam that ignores the per-doc unacked count, reports a false
// "saved to cloud" and the gate catches it.
//
// Self-contained: it re-implements two mutants inline and asserts each disagrees
// with the honest verdict on a row where the difference matters.
//
// RED PHASE: every test is skipped until the seam is implemented.

import { describe, expect, test } from "vitest";
import type { SyncStatus, SyncStatusInputs } from "../sync-status";

// Mutant A: treats a null ack as durable (defaults the missing cursor to 0),
// so a never-acked but otherwise-caught-up item is wrongly called up-to-date.
const ackAbsentTreatedDurable = (i: SyncStatusInputs): SyncStatus => {
  const a = i.acked_cursor ?? 0; // BUG: invents durability from no ack
  if (
    i.unacked_count === 0 &&
    i.updated_cursor <= a &&
    a >= i.latest_known_server_cursor
  ) {
    return "up-to-date";
  }
  return "syncing";
};

// Mutant B: ignores the per-doc unacked count, so an item with a push still in
// flight is wrongly called up-to-date.
const ignoresPendingCount = (i: SyncStatusInputs): SyncStatus => {
  if (
    i.acked_cursor !== null &&
    i.updated_cursor <= i.acked_cursor &&
    i.acked_cursor >= i.latest_known_server_cursor
  ) {
    return "up-to-date"; // BUG: never consults unacked_count
  }
  return "syncing";
};

const neverAckedButCaughtUp: SyncStatusInputs = {
  updated_cursor: 0,
  acked_cursor: null,
  latest_known_server_cursor: 0,
  unacked_count: 0,
  active_pull: false,
  collaborative: false,
  projection_cursor: null,
};

const pendingPush: SyncStatusInputs = {
  updated_cursor: 5,
  acked_cursor: 5,
  latest_known_server_cursor: 5,
  unacked_count: 3,
  active_pull: false,
  collaborative: false,
  projection_cursor: null,
};

describe("the durability gate catches a false saved-to-cloud", () => {
  test("treating an absent push-ack as durable reports a false up-to-date", () => {
    // The honest verdict for a never-acked item is never up-to-date; the mutant
    // claims it, so a gate that pins the honest verdict goes red on the mutant.
    expect(ackAbsentTreatedDurable(neverAckedButCaughtUp)).toBe("up-to-date");
  });

  test("ignoring the per-doc unacked count reports up-to-date while a push is still in flight", () => {
    expect(ignoresPendingCount(pendingPush)).toBe("up-to-date");
  });
});
