// The per-item freshness verdict — the data/sync seam owner.
//
// This is the ONE place a per-item sync verdict is computed. The verdict is
// derived from exact integer-cursor predicates over the canonical-envelope
// cursor (all server-assigned integers, never clocks); the UI is a pure
// renderer of the verdict and MUST NOT re-derive it from raw cursors (a source
// guard forbids the UI importing the predicate or the raw cursor fields).
//
// Placement: the architecture designates packages/db as the canonical home for
// the enum + predicate. Relocating them there would require re-surfacing the
// symbols through this package (the conformance tests import them from here),
// but the repo's biome convention forbids both barrel re-exports (`export … from`)
// and exported imports — so the verdict is single-sourced HERE, the seam tier the
// single-owner source guard sanctions as a compute home. The enum is a plain
// const tuple + union so this seam package needs no zod dependency.

// The three mutually-distinguishable, truthful per-item states. `up-to-date`
// is the ONLY state that may claim cloud durability + recency; it is never a
// premature/false "saved to cloud".
export const SYNC_STATUS = ["up-to-date", "syncing", "may-be-stale"] as const;

export type SyncStatus = (typeof SYNC_STATUS)[number];

// The exact integer-cursor inputs the verdict is derived from. Every cursor is
// a server-assigned integer (never a client clock, never a ULID).
//
//   updated_cursor (u)             — this item's locally-applied cursor
//   acked_cursor (a)               — the per-id push-response cursor for this
//                                    doc's last accepted delta; `null` until the
//                                    push endpoint has returned it. This is the
//                                    SOLE durability gate: while it is null the
//                                    item is NOT durable and can never be
//                                    up-to-date (no false "saved to cloud").
//   latest_known_server_cursor (k) — the max cursor any pull has observed for
//                                    this (collection, scope).
//   unacked_count (q)              — outbox / in-flight (unacked) delta count
//                                    for this doc_id.
//   active_pull                    — a pull is in flight for the (collection,
//                                    scope).
//   collaborative                  — the collection's collaboration mode.
//   projection_cursor (m)          — the materialized projection's applied
//                                    cursor (collaborative only); `null` when no
//                                    tab has ever materialized it.
export interface SyncStatusInputs {
  readonly acked_cursor: number | null;
  readonly active_pull: boolean;
  readonly collaborative: boolean;
  readonly latest_known_server_cursor: number;
  readonly projection_cursor: number | null;
  readonly unacked_count: number;
  readonly updated_cursor: number;
}

// The single pure predicate mapping exact integer-cursor inputs to a verdict.
// Defined in exactly one place; never re-implemented downstream.
//
//   up-to-date   ⟺ (q = 0 ∧ u ≤ a) ∧ a ≥ k ∧ (collaborative ⇒ m ≥ k)
//   syncing      ⟺ q > 0 ∨ (active_pull ∧ a < k) ∨ (collaborative ∧ m < a ∧ m < u)
//   may-be-stale ⟺ otherwise (durable-but-not-recent, a collaborative projection
//                  trailing the latest known server cursor, or a never-acked
//                  quiescent item)
//
// The syncing conditions are evaluated FIRST so `syncing` strictly dominates
// `may-be-stale` whenever both could hold. An absent `acked_cursor` (no per-id
// push-ack has returned) can NEVER be up-to-date — the durability gate.
//
// Recency uses `a ≥ k` (the `a == k` boundary is up-to-date), NOT `a > k`. The
// collaborative active-catch-up signal trails BOTH the durable ack and the local
// update cursor; under the normal `a ≤ u` invariant this is exactly the
// projection-behind-the-durable-ack rule, while a projection that has caught up
// to local work but trails a remote writer reads as the truthful may-be-stale.
export const computeSyncStatus = (inputs: SyncStatusInputs): SyncStatus => {
  const pushPending = inputs.unacked_count > 0;

  const pullBehind =
    inputs.active_pull &&
    (inputs.acked_cursor === null ||
      inputs.acked_cursor < inputs.latest_known_server_cursor);

  const projectionCatchingUp =
    inputs.collaborative &&
    inputs.acked_cursor !== null &&
    inputs.projection_cursor !== null &&
    inputs.projection_cursor < inputs.acked_cursor &&
    inputs.projection_cursor < inputs.updated_cursor;

  if (pushPending || pullBehind || projectionCatchingUp) {
    return "syncing";
  }

  const projectionRecent =
    !inputs.collaborative ||
    (inputs.projection_cursor !== null &&
      inputs.projection_cursor >= inputs.latest_known_server_cursor);

  if (
    inputs.acked_cursor !== null &&
    inputs.unacked_count === 0 &&
    inputs.updated_cursor <= inputs.acked_cursor &&
    inputs.acked_cursor >= inputs.latest_known_server_cursor &&
    projectionRecent
  ) {
    return "up-to-date";
  }

  return "may-be-stale";
};

// The per-item read-model the seam holds: the predicate inputs keyed by doc_id.
// It carries the latest-known-server-cursor reference and the per-doc unacked
// count so the verdict is assertable per item. The real inputs are wired in by
// the seam's callers — `acked_cursor` from the push-response cursor, the unacked
// count from the outbox keyed by doc_id, the latest-known-server-cursor from the
// pull, and the projection cursor from the projection materializer.
export interface SyncStatusReadModel extends SyncStatusInputs {
  readonly doc_id: string;
}

// The single compute locus: assemble the predicate inputs from the read-model
// and delegate to `computeSyncStatus`. The UI renders the returned verdict and
// never touches the raw cursors.
export const deriveItemSyncStatus = (item: SyncStatusReadModel): SyncStatus =>
  computeSyncStatus(item);
