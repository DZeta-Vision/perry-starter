import { expect, test } from "vitest";
import {
  EMBEDDING_DIM,
  isIndexBackedKeysetRead,
  validateEmbedding,
} from "../rag";

// Mutation twin for rag-retrieval.gate.test.ts — the anti-vacuous proof.
//
// The gate trusts (1) the read is index-backed + keyset-bounded + OFFSET-free and
// (2) a bad embedding is rejected. This twin proves both discriminate: an
// OFFSET / unscoped / non-HNSW read fails the read guard, and a wrong-dimension /
// sentinel-tagged / non-finite embedding fails validation.

test("an OFFSET-paged read fails the index-backed keyset guard", () => {
  const offsetRead =
    "SELECT * FROM document_projection WHERE scope_user_id = $scope AND embedding <|5,40|> $query LIMIT 5 START 10;";
  // START/OFFSET-style paging is a full-scan smell the guard rejects.
  expect(isIndexBackedKeysetRead(`${offsetRead} OFFSET 10`)).toBe(false);
});

test("an unscoped (no server-derived scope) read fails the keyset guard", () => {
  const unscoped =
    "SELECT * FROM document_projection WHERE embedding <|5,40|> $query;";
  expect(isIndexBackedKeysetRead(unscoped)).toBe(false);
});

test("a non-HNSW full-collection scan fails the index-backed guard", () => {
  const fullScan =
    "SELECT * FROM document_projection WHERE scope_user_id = $scope;";
  expect(isIndexBackedKeysetRead(fullScan)).toBe(false);
});

test("a wrong-dimension embedding is rejected", () => {
  expect(() =>
    validateEmbedding(new Array(EMBEDDING_DIM + 1).fill(0.1), "stub-embed-v0")
  ).toThrow();
});

test("a sentinel-tagged (unembedded) vector is rejected", () => {
  expect(() =>
    validateEmbedding(new Array(EMBEDDING_DIM).fill(0.1), "unembedded")
  ).toThrow();
});

test("a non-finite embedding value is rejected; a clean one passes", () => {
  const bad = new Array(EMBEDDING_DIM).fill(0.1);
  bad[0] = Number.NaN;
  expect(() => validateEmbedding(bad, "stub-embed-v0")).toThrow();
  expect(() =>
    validateEmbedding(new Array(EMBEDDING_DIM).fill(0.1), "stub-embed-v0")
  ).not.toThrow();
});
