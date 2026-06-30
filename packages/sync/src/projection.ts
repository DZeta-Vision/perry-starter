// @perry-starter/sync — the single-writer projection materializer core.
//
// This is the PURE, transport-tier-safe core of the browser projection writer.
// It NEVER imports loro-crdt or WASM (the Perry integration law: this package is
// daemon-graph-adjacent and stays free of in-process engines). The collaborative
// merge is performed by a `CrdtDoc` port the BROWSER supplies — packages/sync
// only accepts the port; it does not construct or decode Loro itself.
//
// Routing is single-sourced: which convergence path a collection uses is derived
// ONLY from the immutable `collaborationModeRegistry` in @perry-starter/db (never
// redeclared here). Private/non-mergeable collections converge by last-write-wins
// keyed on the server-assigned cursor (highest cursor wins, ascending replay);
// collaborative collections converge by Loro causal merge via the injected port.
//
// Materialization has a SINGLE owner: exactly one writer (the browser in v1) owns
// every DocumentProjection column INCLUDING the embedding. The AI seam computes
// embeddings through its interface but never registers as a projection writer.
//
// All heavy logic is intentionally inert in this define-done slice and throws
// until the green phase activates it; the registry-driven routing helpers are
// real because they only re-use the existing single source.

import type { CollaborationMode } from "@perry-starter/db/collaboration-mode";
import { collaborationModeRegistry } from "@perry-starter/db/collaboration-mode";
import type { DeltaEnvelope } from "@perry-starter/db/shapes/delta-envelope";
import type { DocumentProjection } from "@perry-starter/db/shapes/document-projection";

// --- The CRDT port (browser supplies the concrete adapter) ------------------
// The thin abstraction the browser tier's Loro adapter implements. This is a
// PURE interface — packages/sync carries no loro-crdt/WASM dependency. The
// concrete adapter (deferred to Execute) wraps a loro-crdt `LoroDoc`: it imports
// an opaque base64 delta (idempotent + causal pending-dependency buffering) and
// exposes the merged read-model view. The daemon never sees this port.
export interface CrdtDoc {
  // Apply one opaque base64 Loro update. Idempotent: re-importing the same bytes
  // is a no-op. Out-of-cursor-order delivery still converges (causal merge).
  importDelta(payloadBase64: string): void;
  // The merged read-model view used to project the collaborative row.
  toJSON(): unknown;
}

export type CrdtDocFactory = () => CrdtDoc;

// --- Collaboration-path routing (re-uses the db registry, never redeclares) --
// 'lww'        = private/non-mergeable: D8 highest-server-cursor-wins.
// 'loro-merge' = collaborative: Loro causal merge (the ONLY path that uses Loro).
export type CollaborationPath = "lww" | "loro-merge";

// Pure mode → path mapping. Collaborative is the ONLY mode that uses Loro merge.
export const collaborationPathForMode = (
  mode: CollaborationMode
): CollaborationPath => (mode === "collaborative" ? "loro-merge" : "lww");

// Resolve a collection's convergence path from the single-sourced immutable
// registry. A collection that declared no mode CANNOT be materialized
// (single-sourced-or-fail) — it throws rather than guessing a default.
export const resolveCollaborationPath = (
  collection: string
): CollaborationPath => {
  const mode: CollaborationMode | undefined = Object.hasOwn(
    collaborationModeRegistry,
    collection
  )
    ? (collaborationModeRegistry as Record<string, CollaborationMode>)[
        collection
      ]
    : undefined;
  if (mode === undefined) {
    throw new Error(
      `no collaboration mode is declared for collection "${collection}"`
    );
  }
  return collaborationPathForMode(mode);
};

// --- Single-ownership of the materialized projection ------------------------
export type ProjectionWriterId = string;

// The sole projection writer in v1. The browser owns every projection column.
export const BROWSER_PROJECTION_WRITER: ProjectionWriterId = "browser";

// Process-local single-ownership latch. The first writer to register becomes the
// sole owner; re-registering the SAME writer is an idempotent no-op.
let registeredProjectionWriter: ProjectionWriterId | null = null;

// Register the single projection writer. Registering a SECOND, different writer
// throws — there is exactly one owner of the materialized projection. The AI
// seam computes embeddings through its interface and must never register here.
export const registerProjectionWriter = (
  writerId: ProjectionWriterId
): void => {
  if (
    registeredProjectionWriter !== null &&
    registeredProjectionWriter !== writerId
  ) {
    throw new Error(
      `the projection is already owned by "${registeredProjectionWriter}"; a second writer "${writerId}" may not register`
    );
  }
  registeredProjectionWriter = writerId;
};

// Assert that a materialized column (including `embedding`) is written ONLY by
// the single registered writer. A writer that is not the sole owner — e.g. the
// AI seam, which may COMPUTE the embedding but never WRITES the table — throws.
export const assertColumnOwnedBy = (
  column: keyof DocumentProjection,
  writerId: ProjectionWriterId
): void => {
  if (registeredProjectionWriter === null) {
    throw new Error(
      `no projection writer is registered; column "${column}" has no owner to write it`
    );
  }
  if (writerId !== registeredProjectionWriter) {
    throw new Error(
      `column "${column}" is owned by "${registeredProjectionWriter}", not "${writerId}"`
    );
  }
};

// --- D8 private last-write-wins ---------------------------------------------
// Ascending-cursor replay order: the materializer applies a doc's deltas ordered
// by the server-assigned cursor ascending, so the highest cursor is applied last.
export const replayOrderByCursorAsc = (
  deltas: readonly DeltaEnvelope[]
): readonly DeltaEnvelope[] => [...deltas].sort((a, b) => a.cursor - b.cursor);

// The delta carrying the MAXIMUM server cursor — the highest server-authoritative
// position, immune to input ordering (a fold, not array position) and immune to
// the client ULID/clock (only `cursor` is compared).
const highestCursorDelta = (
  deltas: readonly DeltaEnvelope[]
): DeltaEnvelope => {
  if (deltas.length === 0) {
    throw new Error("cannot select a winner from an empty delta set");
  }
  return deltas.reduce((winner, candidate) =>
    candidate.cursor > winner.cursor ? candidate : winner
  );
};

// D8: for a private/non-mergeable doc, the deterministic LWW winner is the delta
// with the MAXIMUM server-assigned cursor for that doc_id — NEVER the highest
// ULID and NEVER the latest client clock (both are immune to selection here, by
// design, because an offline writer can mint an out-of-order ULID at a LOWER
// cursor). Convergence is over the server-authoritative total order.
export const selectPrivateLwwWinner = (
  deltas: readonly DeltaEnvelope[]
): DeltaEnvelope => highestCursorDelta(deltas);

// --- The materializer -------------------------------------------------------
export interface MaterializeInput {
  collection: string;
  // Injected ONLY for collaborative collections; the private path never touches
  // it (Loro causal merge is used ONLY for collaborative collections).
  crdtDoc?: CrdtDoc;
  deltas: readonly DeltaEnvelope[];
  // The sole writer owns the embedding column, but the VALUE is COMPUTED by the
  // AI seam through its interface and handed in here — the AI seam never writes
  // the table. Absent a computed embedding the row is materialized unembedded.
  embedding?: number[] | null;
  embeddingModel?: string;
  writerId: ProjectionWriterId;
}

// Body-preview cap; the projection stores a short preview, never the full body.
const PREVIEW_LIMIT = 280;
// Embedding-space tag for a row the AI seam has not embedded yet. The column is
// model-tagged so a single index never mixes embedding spaces; an unembedded row
// carries this sentinel until the AI seam computes a real vector + model tag.
const UNEMBEDDED_MODEL_TAG = "unembedded";

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

// Best-effort decode of a private record's opaque base64 snapshot. Private
// collections persist the whole record (LWW, no field merge), so the winning
// delta's payload is the record content. A payload that is not JSON degrades to
// an empty record rather than throwing.
const decodePrivateRecord = (
  payloadBase64: string
): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(atob(payloadBase64));
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const projectColumns = (
  anchor: DeltaEnvelope,
  content: Record<string, unknown>,
  embedding: number[] | null,
  embeddingModel: string | undefined
): DocumentProjection => ({
  doc_id: anchor.doc_id,
  scope_user_id: anchor.scope_user_id,
  title: asString(content.title),
  body_preview: asString(content.body ?? content.body_preview).slice(
    0,
    PREVIEW_LIMIT
  ),
  embedding,
  embedding_model: embeddingModel ?? UNEMBEDDED_MODEL_TAG,
  // Only APPLIED deltas advance the cursor — it is never moved ahead of them, so
  // a lagging (e.g. zero-tab) projection is reported as stale, never as fresh.
  updated_cursor: anchor.cursor,
});

// Materialize the read-only DocumentProjection for one doc.
//  - private collection      → D8 LWW ascending-cursor replay (no Loro at all).
//  - collaborative collection→ feed the opaque base64 payloads into the injected
//    CrdtDoc (Loro causal merge), then project from its merged view.
// Owned by the single registered writer; it writes every column incl. embedding.
export const materializeProjection = (
  input: MaterializeInput
): DocumentProjection => {
  const { collection, crdtDoc, deltas, writerId, embedding, embeddingModel } =
    input;
  // Single-ownership: only the sole registered writer may materialize the table.
  registerProjectionWriter(writerId);
  const path = resolveCollaborationPath(collection);

  if (path === "loro-merge") {
    if (crdtDoc === undefined) {
      throw new Error(
        `collaborative collection "${collection}" requires a CrdtDoc port`
      );
    }
    // Feed the opaque base64 payloads into Loro (causal merge), transport-ordered
    // by cursor; convergence itself is Loro's, not the cursor's.
    for (const delta of replayOrderByCursorAsc(deltas)) {
      crdtDoc.importDelta(delta.payload);
    }
    const view = crdtDoc.toJSON();
    const content =
      view !== null && typeof view === "object"
        ? (view as Record<string, unknown>)
        : {};
    return projectColumns(
      highestCursorDelta(deltas),
      content,
      embedding ?? null,
      embeddingModel
    );
  }

  // Private/non-mergeable: D8 highest-server-cursor LWW. Loro is NEVER touched.
  const winner = selectPrivateLwwWinner(deltas);
  return projectColumns(
    winner,
    decodePrivateRecord(winner.payload),
    embedding ?? null,
    embeddingModel
  );
};
