// Acceptance tests for data-seam conformance.
//
// Verify the store is pluggable behind the data-access seam: it satisfies the
// same single-sourced seam interface the cloud implementation also satisfies,
// and the seam contract documents `node:sqlite` and Electric + Postgres as
// alternatives with SurrealDB as the default. The impl is imported dynamically
// and the seam-contract doc-comment is read via `node:fs`.
//
// The binding, type-level enforcement is the sibling `check-types` test
// `documents.local.satisfies.test.ts` — a `satisfies` / `expectTypeOf` check
// plus a `@ts-expect-error`-guarded negative so removing a method becomes an
// observable `check-types` regression. This runtime test asserts structural
// method-conformance and the alternatives doc-comment.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const REPO_DATA_SRC = join(process.cwd(), "packages", "data", "src");

// The seam method surface the cloud impl will also satisfy (CRUD + keyset
// list). Removing any one from `documents.local.ts` must break conformance.
const SEAM_METHODS = ["create", "read", "update", "delete", "list"] as const;

// Alternatives-doc matchers (top-level: Biome useTopLevelRegex).
const NODE_SQLITE_RE = /node:sqlite/i;
const ELECTRIC_RE = /electric/i;
const POSTGRES_RE = /postgres/i;
const SURREALDB_DEFAULT_RE = /surrealdb[\s\S]*default|default[\s\S]*surrealdb/i;

const dyn = (specifier: string): Promise<Record<string, unknown>> =>
  import(specifier) as Promise<Record<string, unknown>>;

test("documents.local satisfies the single-sourced data-seam interface — same contract as the cloud impl", async () => {
  const dataMod = await dyn("@perry-starter/data/documents.local");
  const makeStore = dataMod.createDocumentsLocal as (cfg: {
    url: string;
    ns: string;
    db: string;
  }) => Record<string, unknown>;

  const store = makeStore({
    url: "http://127.0.0.1:8000",
    ns: "perry",
    db: "perry",
  });

  // Structural conformance to the single-sourced seam interface. Removing a
  // required method from `documents.local.ts` (so it no longer implements the
  // seam) makes one of these assertions fail — mirroring the type-level
  // `satisfies` regression the sibling `check-types` test enforces.
  for (const method of SEAM_METHODS) {
    expect(typeof store[method]).toBe("function");
  }
});

test("the seam contract doc-comment names node:sqlite and Electric+Postgres as alternatives with SurrealDB as the default", () => {
  // The single-sourced seam contract documents the pluggable alternatives. A
  // contract doc that omits an alternative — or does not name SurrealDB as the
  // default — makes one of these assertions fail.
  const contract = readFileSync(join(REPO_DATA_SRC, "documents.ts"), "utf8");

  expect(contract).toMatch(NODE_SQLITE_RE);
  expect(contract).toMatch(ELECTRIC_RE);
  expect(contract).toMatch(POSTGRES_RE);
  expect(contract).toMatch(SURREALDB_DEFAULT_RE);
});
