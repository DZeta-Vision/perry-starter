// @perry-starter/sync — the shared sync module surface.
//
// This is the foundation surface every later sync surface imports. The
// canonical delta envelope is single-sourced in @perry-starter/db; it is
// RE-EXPORTED here (never redeclared), so every sync surface transports one
// consistent, dedup-safe, keyset-orderable shape and the wire and the store
// cannot drift.
//
// Dependency direction (acyclic): sync -> api -> auth -> db. This package
// depends on api contracts and the db shapes; nothing in api/auth/db may
// import this package back. A source guard enforces that direction.
//
// Perry integration law: this package is pure TypeScript over the canonical
// shapes. It never imports Loro/WASM or any in-process engine SDK — the
// browser/sidecar tier produces the opaque base64 payload and the transport
// carries it without decoding.

import type { DeltaEnvelope } from "@perry-starter/db/shapes/delta-envelope";
import { deltaEnvelopeSchema } from "@perry-starter/db/shapes/delta-envelope";

// The canonical envelope is single-sourced in @perry-starter/db; every sync
// surface imports it from there directly (no barrel re-export here). This
// module derives the pre-push variant from it and never redeclares any field.
//
// The pre-push / unacked client envelope: identical to the canonical shape
// MINUS the server-assigned `cursor`, which only exists once the push endpoint
// has minted it from the cursor sequence. Derived from the canonical shape so
// it can never drift from — nor relax — the six-field contract.
export const unackedDeltaSchema = deltaEnvelopeSchema.omit({ cursor: true });
export type UnackedDelta = Omit<DeltaEnvelope, "cursor">;

// The single append-only delta-log table every sync surface reads and writes.
export const DELTA_TABLE = "document_delta" as const;

const NOT_IMPLEMENTED = "sync transport is not implemented yet";

// One monotonic ingest sequence per (collection, scope). The server-assigned
// cursor is advanced from this named sequence (`sequence::nextval(<name>)`) —
// never a MAX(cursor)+1 read-then-write, which reproduces the concurrency race
// the design forbids: two readers see the same max, mint the same cursor, and a
// causally-later op sorts before an earlier one. The name encodes both the
// collection and the scope so two scopes never share a counter.
export const cursorSequenceName = (
  collection: string,
  scopeUserId: string
): string => `seq_${collection}_${scopeUserId}`;

// --- Inert surface stubs ----------------------------------------------------
// These anchor the surface that the later transport work fills in. They are
// intentionally unimplemented in this foundation slice and throw until then.

// Idempotent batched push: dedups by the client-minted ULID and returns the
// server-assigned cursor for each accepted delta id.
export const pushDeltas = (
  _deltas: readonly UnackedDelta[]
): Promise<never> => {
  throw new Error(NOT_IMPLEMENTED);
};

// Since-cursor keyset pull: returns only deltas with a cursor strictly greater
// than the supplied one, ordered by the (scope_user_id, cursor) range index,
// at a cost proportional to the number of new deltas (no OFFSET).
export const pullSince = (
  _scopeUserId: string,
  _sinceCursor: number
): Promise<never> => {
  throw new Error(NOT_IMPLEMENTED);
};
