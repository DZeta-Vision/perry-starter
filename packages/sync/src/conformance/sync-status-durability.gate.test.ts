// Conformance gate — up-to-date requires BOTH durability and recency, and is
// never claimed on a local write alone (no false "saved to cloud").
//
// Durability half: the per-id push-response cursor (acked_cursor) must have
// returned — while it is null the item is not durable and can never be
// up-to-date. Recency half: the durable ack must be at or past the latest known
// server cursor. Both halves are combined by the single seam owner, which reads
// a per-item read-model carrying the latest-known-server-cursor reference and
// the per-doc unacked count. Its paired mutation twin proves a predicate that
// drops the durability gate (or the pending count) reports a false up-to-date.
//
// RED PHASE: every test is skipped until the seam is implemented.

import { describe, expect, test } from "vitest";
import type { SyncStatusInputs, SyncStatusReadModel } from "../sync-status";
import { computeSyncStatus, deriveItemSyncStatus } from "../sync-status";

const settled = (): SyncStatusInputs => ({
  updated_cursor: 5,
  acked_cursor: 5,
  latest_known_server_cursor: 5,
  unacked_count: 0,
  active_pull: false,
  collaborative: false,
  projection_cursor: null,
});

const DOC_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("up-to-date requires durability and recency, never a local write alone", () => {
  test("a never-acked local write with queued work is syncing, never up-to-date", () => {
    const verdict = computeSyncStatus({
      ...settled(),
      acked_cursor: null,
      unacked_count: 1,
    });
    expect(verdict).toBe("syncing");
    expect(verdict).not.toBe("up-to-date");
  });

  test("a never-acked item is never up-to-date across recency and pending combinations (no false saved-to-cloud)", () => {
    const recencyValues = [3, 5, 7];
    const pendingValues = [0, 1, 4];
    for (const k of recencyValues) {
      for (const q of pendingValues) {
        expect(
          computeSyncStatus({
            ...settled(),
            acked_cursor: null,
            latest_known_server_cursor: k,
            unacked_count: q,
          })
        ).not.toBe("up-to-date");
      }
    }
  });

  test("dropping either half blocks up-to-date: durable-but-not-recent is may-be-stale", () => {
    // Durability present, recency absent (a < k), nothing pending.
    expect(
      computeSyncStatus({ ...settled(), latest_known_server_cursor: 9 })
    ).toBe("may-be-stale");
  });

  test("dropping either half blocks up-to-date: recent-but-not-durable is never up-to-date", () => {
    // Recency would be satisfied (a would be >= k) but no ack ever returned.
    expect(
      computeSyncStatus({
        ...settled(),
        acked_cursor: null,
        latest_known_server_cursor: 0,
        unacked_count: 0,
      })
    ).not.toBe("up-to-date");
  });
});

describe("the seam derives the verdict from a per-item read-model keyed by doc_id", () => {
  test("the read-model carries the latest-known-server-cursor and the per-doc unacked count", () => {
    const item: SyncStatusReadModel = {
      doc_id: DOC_ID,
      updated_cursor: 5,
      acked_cursor: 5,
      latest_known_server_cursor: 5,
      unacked_count: 0,
      active_pull: false,
      collaborative: false,
      projection_cursor: null,
    };
    expect(deriveItemSyncStatus(item)).toBe("up-to-date");
    // A queued delta for this doc flips the same read-model to syncing.
    expect(deriveItemSyncStatus({ ...item, unacked_count: 2 })).toBe("syncing");
  });

  test("a collaborative item with no materializing tab sits in may-be-stale (truthful indefinite lag)", () => {
    const noTab: SyncStatusReadModel = {
      doc_id: DOC_ID,
      updated_cursor: 5,
      acked_cursor: 5,
      latest_known_server_cursor: 5,
      unacked_count: 0,
      active_pull: false,
      collaborative: true,
      projection_cursor: null,
    };
    const verdict = deriveItemSyncStatus(noTab);
    expect(verdict).toBe("may-be-stale");
    expect(verdict).not.toBe("up-to-date");
  });
});
