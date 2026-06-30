// Since-cursor keyset pull — the recency half of the sync flow.
//
// Returns only deltas whose server cursor is strictly greater than the supplied
// last-seen cursor, scoped by `scope_user_id` and ordered ascending by the
// trailing (scope_user_id, cursor) range index:
//
//   WHERE scope_user_id = $s AND cursor > $since ORDER BY cursor ASC LIMIT $n
//
// There is NO START/OFFSET deep-paging — the next page is always the keyset
// continuation (`cursor > latestCursor`), so the cost is proportional to the
// number of NEW deltas, not the number scanned. An empty result is an EXPLICIT
// caught-up end-state — never an error and never an open-ended spinner.
//
// The cursor orders transport only; convergence is left to Loro causal merge
// (collaborative) or highest-cursor-wins (private). The base64 payload is
// carried opaquely and is never decoded here.

import type { DeltaEnvelope } from "@perry-starter/db/shapes/delta-envelope";
import { deltaEnvelopeSchema } from "@perry-starter/db/shapes/delta-envelope";
import { DELTA_TABLE } from "./index";
import type { DeltaLogTransport } from "./transport";

// A guard against a non-integer cursor or page size reaching the inlined keyset
// query (the cursor compares against an int column and the page size is a LIMIT;
// neither can be a string bind variable, so both are validated and inlined).
const requireSafeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`);
  }
  return value;
};

// The default keyset page size. Paging advances by the last-seen cursor, never
// OFFSET, so each page costs O(new). Value-independent: the next page is always
// the keyset continuation.
export const DEFAULT_PULL_PAGE_SIZE = 500;

// The explicit result of a since-cursor keyset pull.
export interface PullPage {
  // True when this page returned fewer than the page size — the keyset is
  // exhausted and the client is caught up (includes the empty case). A definite
  // end-state, never an error or an open page.
  readonly caughtUp: boolean;
  // New deltas with cursor strictly greater than the supplied cursor, ordered
  // ascending by the server cursor (transport order only). Empty when nothing is
  // newer than the supplied cursor.
  readonly deltas: readonly DeltaEnvelope[];
  // The highest cursor in this page; the client advances its last-seen cursor to
  // it. Equal to the supplied cursor when the page is empty.
  readonly latestCursor: number;
}

export interface PullDeps {
  readonly pageSize?: number;
  readonly transport: DeltaLogTransport;
}

// The keyset columns the pull projects, in the canonical envelope order. The
// stored row carries the ULID as `op_id` (the record id is `document_delta:<ulid>`);
// it is projected back to the envelope's `id`.
const PULL_FIELDS =
  "op_id, doc_id, scope_user_id, doc_schema_version, cursor, payload";

// Parse one transport row into the canonical envelope, mapping the stored op-id
// back to the envelope id. The strict schema rejects any drift.
const toEnvelope = (row: Record<string, unknown>): DeltaEnvelope =>
  deltaEnvelopeSchema.parse({
    id: row.op_id,
    scope_user_id: row.scope_user_id,
    doc_id: row.doc_id,
    doc_schema_version: row.doc_schema_version,
    cursor: row.cursor,
    payload: row.payload,
  });

// Since-cursor keyset pull (see file header). Returns only deltas with cursor
// strictly greater than the supplied cursor, ordered ascending and range-backed
// by the (scope_user_id, cursor) composite index — NO START/OFFSET. An empty
// result is the explicit caught-up end-state.
export const pullSinceCursor = async (
  scopeUserId: string,
  sinceCursor: number,
  deps: PullDeps
): Promise<PullPage> => {
  const since = requireSafeInteger(sinceCursor, "since cursor");
  const pageSize = requireSafeInteger(
    deps.pageSize ?? DEFAULT_PULL_PAGE_SIZE,
    "page size"
  );

  // The scope is a parameterized bind variable; the cursor bound and the page
  // limit are validated integers inlined as literals (query-string bind vars are
  // strings, which would defeat the int comparison and the LIMIT). There is no
  // START/OFFSET — the next page is the keyset continuation past `latestCursor`.
  const query = `SELECT ${PULL_FIELDS} FROM ${DELTA_TABLE} WHERE scope_user_id = $scope AND cursor > ${since} ORDER BY cursor ASC LIMIT ${pageSize};`;
  const rows = await deps.transport.run(query, { scope: scopeUserId });

  const firstResult = rows[0]?.result;
  const records = Array.isArray(firstResult)
    ? (firstResult as Record<string, unknown>[])
    : [];
  const deltas = records.map(toEnvelope);
  const lastDelta = deltas.at(-1);

  return {
    deltas,
    latestCursor: lastDelta ? lastDelta.cursor : since,
    caughtUp: deltas.length < pageSize,
  };
};
