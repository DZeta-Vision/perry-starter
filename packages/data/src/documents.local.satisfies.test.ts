import { expect, expectTypeOf, test } from "vitest";
import type { DocumentsDataSeam } from "./documents";
import { createDocumentsLocal } from "./documents.local";

// Type-level conformance: the local store must implement the same single-sourced
// seam interface the cloud implementation also satisfies. `bun run check-types`
// is the enforcer — if a required method is removed the assignment below stops
// type-checking.

const STORE_CONFIG = {
  url: "http://127.0.0.1:8000",
  ns: "perry",
  db: "perry",
} as const;

test("the local store conforms to the shared data seam", () => {
  const store: DocumentsDataSeam = createDocumentsLocal(STORE_CONFIG);
  expectTypeOf(store).toEqualTypeOf<DocumentsDataSeam>();
  expect(store).toBeDefined();
});

test("dropping a seam method is an observable type regression", () => {
  const store = createDocumentsLocal(STORE_CONFIG);
  // Omitting `list` must break seam conformance. If the seam ever stopped
  // requiring `list`, this directive would become unused and fail the build —
  // keeping the regression observable.
  // @ts-expect-error - a store without `list` does not satisfy the seam
  const incomplete: DocumentsDataSeam = {
    create: store.create,
    read: store.read,
    update: store.update,
    delete: store.delete,
  };
  expect(incomplete).toBeDefined();
});
