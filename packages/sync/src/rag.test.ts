import type { DocumentProjection } from "@perry-starter/db/shapes/document-projection";
import { expect, test } from "vitest";
import {
  decodePrivateRecord,
  encodePrivateRecord,
  isValidPrivateRecordEncoding,
} from "./projection";
import { buildProjectionUpsertSql, EMBEDDING_DIM, fillEmbedding } from "./rag";

// A spliced (non-bound) string value in the write body would look like `title: '`.
const SPLICED_STRING_VALUE = /title:\s*'/;

// d76: private-record content encoding + content-validation.
test("the private-record encoding round-trips base64(JSON) and validates content", () => {
  const record = { title: "Notes", body: "Ground truth." };
  const encoded = encodePrivateRecord(record);
  expect(isValidPrivateRecordEncoding(encoded)).toBe(true);
  expect(decodePrivateRecord(encoded)).toEqual(record);
});

test("a non-JSON / non-object payload is invalid and decodes to an empty record (degrade, not throw)", () => {
  expect(isValidPrivateRecordEncoding("not-base64-json!!")).toBe(false);
  expect(isValidPrivateRecordEncoding(btoa("42"))).toBe(false); // JSON, but not an object
  expect(decodePrivateRecord("not-base64-json!!")).toEqual({});
});

// d76: the projection .surql write path.
test("the projection UPSERT write path is idempotent, keyed, and fully $-bound", () => {
  const sql = buildProjectionUpsertSql();
  expect(sql).toContain("UPSERT");
  expect(sql).toContain("type::thing($tb, [$scope, $doc])");
  for (const bind of [
    "$scope",
    "$doc",
    "$title",
    "$preview",
    "$embedding",
    "$model",
    "$cursor",
  ]) {
    expect(sql).toContain(bind);
  }
  // No spliced string values in the write body.
  expect(sql).not.toMatch(SPLICED_STRING_VALUE);
});

// May-be-stale honesty: filling the embedding must NOT advance the cursor, so a
// lagging (e.g. no-tab-materialized) projection stays honestly stale.
test("filling the embedding preserves updated_cursor (no false freshness)", async () => {
  const base: DocumentProjection = {
    doc_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    scope_user_id: "01BX5ZZKBKACTAV9WEVGEMMVRZ",
    title: "T",
    body_preview: "B",
    embedding: null,
    embedding_model: "unembedded",
    updated_cursor: 7,
  };
  const filled = await fillEmbedding(base, (_text) =>
    Promise.resolve({
      model: "stub-embed-v0",
      vector: new Array(EMBEDDING_DIM).fill(0.25),
    })
  );
  expect(filled.updated_cursor).toBe(7);
  expect(filled.embedding).toHaveLength(EMBEDDING_DIM);
});
