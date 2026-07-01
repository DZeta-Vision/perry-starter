// Idempotent batched push — the durable half of the sync flow.
//
// One batched op carries the client's queued deltas to the cloud log through the
// injected forwarder transport. It dedups by the client-minted ULID id (the
// server `id` UNIQUE constraint over the PERMISSIONS NONE log), mints a
// server-assigned cursor per newly-accepted delta from the (collection,scope)
// sequence, and returns the cursor PER accepted delta id. A replay of an
// already-ingested id is a harmless no-op — no duplicate row, no error — and
// reports that id's existing cursor, so a re-push after a partial prior attempt
// converges to one row set and the same per-id cursors.
//
// The per-id ack cursor is the SOLE wire signal that an item's local write is
// durably ingested in the cloud log; it is necessary-but-not-sufficient for
// up-to-date (the recency half comes from the pull). It is never inferred from a
// local write success.
//
// Perry integration law: the base64 payload is carried opaquely and is NEVER
// decoded here; no Loro/WASM/in-process engine SDK is imported on this path.

import type { UnackedDelta } from "./index";
import { cursorSequenceName, DELTA_TABLE, unackedDeltaSchema } from "./index";
import type { DeltaLogTransport } from "./transport";

// The per-(collection,scope) cursor sequence is created on first use. BATCH is a
// counter pre-allocation hint; START 1 makes the first minted cursor a positive
// integer (mirrors the sequence the keyset pull orders on).
const SEQUENCE_BATCH = 1000;
const SEQUENCE_START = 1;

// The bounded push-batch ceiling. A single push carries at most this many
// deltas; an over-limit batch is rejected WHOLE — before any transport call — so
// the log can never be left in an ambiguous partial ingestion. The exact number
// is a sensible client-flush granularity comfortably under any statement-size
// limit; the reject-whole BEHAVIOR is value-independent.
export const MAX_PUSH_BATCH = 500;

// The per-id durability ack: the server-assigned cursor minted for one accepted
// delta id. The freshness seam consumes it to clear an item from saved-local to
// syncing.
export interface DeltaAck {
  readonly cursor: number;
  readonly id: string;
}

// The verdict from the single revocation-discovery flush authority, INJECTED
// into the push and never re-derived here: only "flush" ingests; "hold" and
// "quarantine" perform NO ingestion and preserve the queue intact under each
// item's stamped owning subject.
export type FlushVerdict = "flush" | "hold" | "quarantine";

export type PushOutcome = "flushed" | "held" | "quarantined";

export interface PushResult {
  // One ack per delta id in the batch. A newly-accepted id carries its freshly
  // minted server cursor; a replayed (already-ingested) id carries its EXISTING
  // cursor, so a replay converges to the same per-id cursor set. Empty when the
  // flush verdict withheld ingestion.
  readonly acks: readonly DeltaAck[];
  readonly outcome: PushOutcome;
}

export interface PushDeps {
  // The collection whose per-(collection,scope) cursor sequence mints cursors.
  readonly collection: string;
  // The SERVER-DERIVED scope every row in this batch is stamped under — REQUIRED.
  // The client-supplied per-delta scope_user_id is NEVER used for placement, so a
  // forged scope in the request body can never land a row under another owner.
  // This is the write leg of the cross-scope perimeter, and it is fail-CLOSED:
  // there is no code path that writes a delta under a client-chosen scope. The
  // caller (the cloud forwarder, derived from the session, never client-asserted)
  // MUST supply it; an absent/empty value is rejected, never silently defaulted.
  // It is threaded down as data, so this package keeps no build edge to the auth
  // tier.
  readonly enforcedScopeUserId: string;
  // The injected flush authority verdict; the push routes through it and never
  // re-derives the revocation decision.
  readonly flushVerdict: FlushVerdict;
  // The opaque forwarder transport (the single-forwarder cloud seam).
  readonly transport: DeltaLogTransport;
}

// Thrown when a push reaches the delta-log without a server-derived enforced
// scope. The perimeter is fail-CLOSED: rather than fall back to the
// client-supplied scope (which a forged request controls), the push refuses
// outright, so a caller that forgets to inject the derived scope writes nothing.
export class MissingEnforcedScopeError extends Error {
  constructor() {
    super(
      "push requires a server-derived enforced scope; refusing to stamp a client-supplied scope"
    );
    this.name = "MissingEnforcedScopeError";
  }
}

// Thrown when a batch exceeds the bounded limit. The push rejects the batch
// WHOLE before any transport call, so an over-limit push ingests zero rows.
export class BatchTooLargeError extends Error {
  readonly limit: number;
  readonly size: number;

  constructor(size: number, limit: number) {
    super(`push batch of ${size} exceeds the bounded limit of ${limit}`);
    this.name = "BatchTooLargeError";
    this.size = size;
    this.limit = limit;
  }
}

// A SurrealDB sequence name is interpolated as an identifier in the DEFINE
// statement (a DDL identifier cannot be a bind variable), so it is backtick
// quoted and a name carrying a backtick is refused outright — the name can never
// break out of the quoting and inject SurrealQL. Everywhere else the name travels
// as a parameterized `$seq_n` bind variable into `sequence::nextval`.
const quoteSequenceIdent = (name: string): string => {
  if (name.includes("`")) {
    throw new Error("refusing to build an unsafe sequence identifier");
  }
  return `\`${name}\``;
};

// Wrap a schema-validated value as a SurrealQL single-quoted string literal. The
// id / doc-id are ULIDs (Crockford base32) and the payload is base64 — none of
// those charsets can contain a quote or backslash, so the value can never break
// out of the literal. The guard asserts that invariant defensively: a value
// carrying a quote/backslash (which a validated delta never has) is refused
// rather than inlined. The payload is carried VERBATIM — placed in the statement
// text unchanged, never decoded. Values that are NOT charset-restricted (the
// arbitrary scope id) travel as `$bind` variables instead, never inlined.
const singleQuote = (value: string): string => {
  if (value.includes("'") || value.includes("\\")) {
    throw new Error("refusing to inline an unsafe string literal");
  }
  return `'${value}'`;
};

interface BatchedPush {
  readonly query: string;
  readonly vars: Record<string, string>;
}

// Build the ONE batched op: a `DEFINE SEQUENCE … IF NOT EXISTS` per distinct
// (collection,scope) sequence followed by one keyed UPSERT per delta. The UPSERT
// is keyed on the client-minted ULID record id, so a replay updates in place
// (no second row) and the UNIQUE op-id index backstops it; the cursor is minted
// from the sequence ONLY when the row has none yet (`IF cursor IS NONE`), so a
// replay keeps its original cursor and the sequence is never advanced twice for
// the same id. Each accepted row RETURNs its op-id + server cursor.
//
// The arbitrary-charset scope id (and the scope-derived sequence name) travel as
// `$scope_n` / `$seq_n` bind variables — one pair per DISTINCT scope, so the
// per-request bind set stays small regardless of batch size (the query-string
// bind channel is URL-length bounded; a 500-delta batch would overflow it). The
// charset-restricted, schema-validated values (ULID ids, base64 payload, integer
// schema version) are inlined into the statement body, which is unbounded. The
// payload is inlined VERBATIM and never decoded.
const buildBatch = (
  deltas: readonly UnackedDelta[],
  collection: string,
  enforcedScopeUserId: string
): BatchedPush => {
  const vars: Record<string, string> = {};
  const defineStatements: string[] = [];
  const upsertStatements: string[] = [];
  const scopeVarIndex = new Map<string, number>();

  for (const raw of deltas) {
    const delta = unackedDeltaSchema.parse(raw);
    // Every row is stamped with the SERVER-DERIVED enforced scope — NEVER the
    // client-supplied delta.scope_user_id (validated for shape, but never used
    // for placement). There is no fallback, so a forged scope cannot widen the
    // perimeter and one push writes under exactly one scope (one session).
    const scopeUserId = enforcedScopeUserId;
    let scopeIndex = scopeVarIndex.get(scopeUserId);
    if (scopeIndex === undefined) {
      scopeIndex = scopeVarIndex.size;
      scopeVarIndex.set(scopeUserId, scopeIndex);
      const sequenceName = cursorSequenceName(collection, scopeUserId);
      vars[`scope_${scopeIndex}`] = scopeUserId;
      vars[`seq_${scopeIndex}`] = sequenceName;
      defineStatements.push(
        `DEFINE SEQUENCE IF NOT EXISTS ${quoteSequenceIdent(sequenceName)} BATCH ${SEQUENCE_BATCH} START ${SEQUENCE_START};`
      );
    }
    const id = singleQuote(delta.id);
    upsertStatements.push(
      `UPSERT type::record(${singleQuote(DELTA_TABLE)}, ${id}) SET op_id = ${id}, doc_id = ${singleQuote(delta.doc_id)}, scope_user_id = $scope_${scopeIndex}, doc_schema_version = ${delta.doc_schema_version}, payload = ${singleQuote(delta.payload)}, cursor = IF cursor IS NONE THEN sequence::nextval($seq_${scopeIndex}) ELSE cursor END RETURN op_id, cursor;`
    );
  }

  return {
    query: [...defineStatements, ...upsertStatements].join("\n"),
    vars,
  };
};

// Read the per-id durability acks back out of the transport response. Each
// accepted UPSERT returns `[{ op_id, cursor }]`; a per-statement ERR is surfaced
// as a thrown error rather than a silent partial ack (HTTP 200 ≠ success).
const extractAcks = (
  rows: readonly { readonly status: "OK" | "ERR"; readonly result: unknown }[]
): DeltaAck[] => {
  const acks: DeltaAck[] = [];
  for (const row of rows) {
    if (row.status === "ERR") {
      throw new Error(`delta-log push statement failed: ${String(row.result)}`);
    }
    if (!Array.isArray(row.result)) {
      continue;
    }
    for (const item of row.result) {
      if (
        item &&
        typeof item === "object" &&
        "op_id" in item &&
        "cursor" in item
      ) {
        const opId = (item as { op_id: unknown }).op_id;
        const cursor = (item as { cursor: unknown }).cursor;
        if (typeof opId === "string" && typeof cursor === "number") {
          acks.push({ id: opId, cursor });
        }
      }
    }
  }
  return acks;
};

// Idempotent batched push (see file header). The batch is bounded and rejected
// WHOLE before any egress; the flush verdict gates ingestion (only "flush" ever
// reaches the transport); the accepted deltas are ingested in ONE batched op and
// each returns its server-assigned cursor.
export const pushDeltaBatch = async (
  deltas: readonly UnackedDelta[],
  deps: PushDeps
): Promise<PushResult> => {
  // Fail-CLOSED perimeter precondition: the server-derived scope is mandatory.
  // Without it the push refuses outright rather than fall back to the
  // client-supplied scope, so no forged/missing-scope request can write a row.
  if (!deps.enforcedScopeUserId) {
    throw new MissingEnforcedScopeError();
  }

  // Reject an over-limit batch WHOLE, before any egress — the log can never be
  // left in an ambiguous partial-ingestion state.
  if (deltas.length > MAX_PUSH_BATCH) {
    throw new BatchTooLargeError(deltas.length, MAX_PUSH_BATCH);
  }

  // Route through the injected flush authority; never re-derive the decision.
  // Only an affirmative "flush" verdict ingests — "hold"/"quarantine" perform NO
  // egress and preserve the queue intact.
  if (deps.flushVerdict !== "flush") {
    const outcome: PushOutcome =
      deps.flushVerdict === "quarantine" ? "quarantined" : "held";
    return { acks: [], outcome };
  }

  // An empty flush is a no-op; nothing reaches the transport.
  if (deltas.length === 0) {
    return { acks: [], outcome: "flushed" };
  }

  const { query, vars } = buildBatch(
    deltas,
    deps.collection,
    deps.enforcedScopeUserId
  );
  const rows = await deps.transport.run(query, vars);
  return { acks: extractAcks(rows), outcome: "flushed" };
};
