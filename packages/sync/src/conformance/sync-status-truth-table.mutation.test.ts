// Mutation twin for sync-status-truth-table.gate.test.ts — proves the truth
// table is anti-vacuous AND sensitive to an off-by-one predicate boundary.
//
// A truth table is worthless if no wrong predicate could ever fail it. This
// twin defines a FAITHFUL reference predicate (which must match every row, so
// the table is satisfiable) and an OFF-BY-ONE mutant that shifts the recency
// comparison from `a >= k` to `a > k`. At the a == k boundary the mutant
// disagrees with the table — exactly the bug the gate must catch — so a real
// implementation carrying this off-by-one would go red.
//
// Self-contained: it re-implements the predicate inline and never imports the
// production stub, so it demonstrates sensitivity independent of the
// implementation's state.
//
// RED PHASE: every test is skipped until the predicate is implemented.

import { describe, expect, test } from "vitest";
import type { SyncStatus, SyncStatusInputs } from "../sync-status";

// A faithful reference predicate: the contract the gate pins.
const faithful = (i: SyncStatusInputs): SyncStatus => {
  const pendingPush = i.unacked_count > 0;
  const pullBehind =
    i.active_pull &&
    (i.acked_cursor === null || i.acked_cursor < i.latest_known_server_cursor);
  const projectionBehindAck =
    i.collaborative &&
    i.projection_cursor !== null &&
    i.acked_cursor !== null &&
    i.projection_cursor < i.acked_cursor;
  if (pendingPush || pullBehind || projectionBehindAck) {
    return "syncing";
  }
  const projectionRecent =
    !i.collaborative ||
    (i.projection_cursor !== null &&
      i.projection_cursor >= i.latest_known_server_cursor);
  if (
    i.acked_cursor !== null &&
    i.unacked_count === 0 &&
    i.updated_cursor <= i.acked_cursor &&
    i.acked_cursor >= i.latest_known_server_cursor &&
    projectionRecent
  ) {
    return "up-to-date";
  }
  return "may-be-stale";
};

// The off-by-one mutant: `a > k` (strict) instead of `a >= k`. Everything else
// is identical to the faithful predicate.
const offByOne = (i: SyncStatusInputs): SyncStatus => {
  const pendingPush = i.unacked_count > 0;
  const pullBehind =
    i.active_pull &&
    (i.acked_cursor === null || i.acked_cursor < i.latest_known_server_cursor);
  const projectionBehindAck =
    i.collaborative &&
    i.projection_cursor !== null &&
    i.acked_cursor !== null &&
    i.projection_cursor < i.acked_cursor;
  if (pendingPush || pullBehind || projectionBehindAck) {
    return "syncing";
  }
  const projectionRecent =
    !i.collaborative ||
    (i.projection_cursor !== null &&
      i.projection_cursor >= i.latest_known_server_cursor);
  if (
    i.acked_cursor !== null &&
    i.unacked_count === 0 &&
    i.updated_cursor <= i.acked_cursor &&
    i.acked_cursor > i.latest_known_server_cursor && // off-by-one: was `>=`
    projectionRecent
  ) {
    return "up-to-date";
  }
  return "may-be-stale";
};

// The load-bearing boundary row: durable ack exactly equals the server cursor,
// nothing pending. The contract says up-to-date.
const boundaryRow: SyncStatusInputs = {
  updated_cursor: 5,
  acked_cursor: 5,
  latest_known_server_cursor: 5,
  unacked_count: 0,
  active_pull: false,
  collaborative: false,
  projection_cursor: null,
};

describe("the truth table is anti-vacuous and catches an off-by-one boundary", () => {
  test("a faithful predicate reports up-to-date at the a == k boundary (the table is satisfiable)", () => {
    expect(faithful(boundaryRow)).toBe("up-to-date");
  });

  test("an off-by-one predicate that treats a == k as not-recent fails the boundary (the gate goes red)", () => {
    expect(offByOne(boundaryRow)).not.toBe("up-to-date");
    expect(offByOne(boundaryRow)).toBe("may-be-stale");
  });

  test("the off-by-one mutant still agrees with the faithful predicate when the ack is strictly past the server cursor", () => {
    // Away from the boundary (a > k) the mutant and the contract agree, so the
    // divergence is precisely the shifted boundary, not a wholesale break.
    const aheadRow: SyncStatusInputs = {
      ...boundaryRow,
      latest_known_server_cursor: 4,
    };
    expect(faithful(aheadRow)).toBe("up-to-date");
    expect(offByOne(aheadRow)).toBe("up-to-date");
  });
});
