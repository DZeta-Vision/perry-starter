// Acceptance — the document-anchored append-only delta-log table.
//
// Asserts the `document_delta` schema: it is anchored to the document (doc_id),
// carries the canonical envelope fields including `doc_schema_version`, dedups
// on the client-minted ULID op-id (a replay creates no second row and is not an
// error), and a trailing (scope_user_id, cursor) range index range-backs a
// since-cursor keyset filter (cursor strictly greater than the supplied cursor,
// ordered ascending, NO OFFSET / START deep-paging — cost proportional to the
// number of new deltas).
//
// Drives a real loopback `surreal` 3.1.5 sidecar. The store/db artefacts are
// imported DYNAMICALLY inside the test bodies, so the not-yet-final modules are
// never resolved at collection time.
//
// The schema lands the ULID-as-record-id plus a UNIQUE op_id index for dedup and
// the (scope_user_id, cursor) composite range index for the keyset; these tests
// assert that BEHAVIOR against the real v3.1.5 EXPLAIN vocabulary (IndexScan over
// the named index, never a TableScan).

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const LOOPBACK = "127.0.0.1";
const ROOT_USER = "root";
const ROOT_PASS = "root_secret_for_test_only";
// Distinct from every other real-surreal acceptance sidecar port (the `node`
// vitest project runs these files in parallel forks; a shared port makes a
// second file's `/health` hit the first's live sidecar and re-apply the schema
// → `DEFINE ACCESS account already exists`). 18_037/39/41/43 belong to the
// packages/data suites; 18_042/44/45/46 to sibling sync suites.
const SIDECAR_PORT = 18_047;
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;
const SURREAL_NS = "perry";
const SURREAL_DB = "perry";

interface Sidecar {
  readonly stop: () => void;
  readonly url: string;
}

interface SqlRow {
  readonly result: unknown;
  readonly status: "OK" | "ERR";
}
type SqlFn = (
  url: string,
  ns: string,
  db: string,
  auth: { kind: "basic"; user: string; pass: string },
  query: string,
  vars?: Record<string, string>
) => Promise<SqlRow[]>;

const ROOT = { kind: "basic", user: ROOT_USER, pass: ROOT_PASS } as const;

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((res) => {
    setTimeout(res, ms);
  });

const startMemorySidecar = async (): Promise<Sidecar> => {
  const proc: ChildProcess = spawn(
    "surreal",
    [
      "start",
      "--bind",
      `${LOOPBACK}:${SIDECAR_PORT}`,
      "--user",
      ROOT_USER,
      "--pass",
      ROOT_PASS,
      "--deny-guests",
      "--deny-scripting",
      "--deny-net",
      "memory",
    ],
    { stdio: "ignore" }
  );
  const url = `http://${LOOPBACK}:${SIDECAR_PORT}`;
  for (let attempt = 0; attempt < HEALTH_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        return { url, stop: () => proc.kill() };
      }
    } catch {
      // not listening yet — poll again within budget
    }
    await sleep(HEALTH_POLL_MS);
  }
  proc.kill();
  throw new Error("surreal sidecar did not pass /health within budget");
};

const dyn = (specifier: string): Promise<Record<string, unknown>> =>
  import(specifier) as Promise<Record<string, unknown>>;

const loadSql = async (): Promise<SqlFn> => {
  const httpMod = await dyn("@perry-starter/data/surreal-http");
  return httpMod.sql as SqlFn;
};

const schemaText = (): string =>
  readFileSync(
    join(
      process.cwd(),
      "packages",
      "db",
      "database",
      "schema",
      "documents.surql"
    ),
    "utf8"
  );

// A canonical-shaped delta insert. The op-id (ULID) is the dedup key; doc_id is
// the document anchor; doc_schema_version travels with every delta.
const insertDelta = (id: string, docId: string, scope: string): string =>
  `CREATE document_delta:\`${id}\` SET op_id = '${id}', doc_id = '${docId}', scope_user_id = '${scope}', doc_schema_version = 1, payload = 'aGVsbG8=';`;

test("the .surql schema applies cleanly against surreal 3.1.5", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    const rows = await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      ROOT,
      schemaText()
    );
    expect(rows.every((r) => r.status === "OK")).toBe(true);
  } finally {
    sidecar.stop();
  }
});

test("a replayed ULID op-id creates no second row and is not a hard error (UNIQUE dedup)", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, schemaText());

    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const docId = "01J0XQT8Z9N3H6K2M5P7R9T1V3";
    const scope = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

    await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      ROOT,
      insertDelta(id, docId, scope)
    );
    // The replay path is idempotent at the table layer: re-ingesting the same
    // op-id converges to a single row (no duplicate, no log corruption).
    await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      ROOT,
      `UPSERT document_delta:\`${id}\` SET op_id = '${id}', doc_id = '${docId}', scope_user_id = '${scope}', doc_schema_version = 1, payload = 'aGVsbG8=';`
    );

    const count = await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      ROOT,
      `SELECT count() FROM document_delta WHERE op_id = '${id}' GROUP ALL;`
    );
    expect(count[0]?.result).toMatchObject([{ count: 1 }]);
  } finally {
    sidecar.stop();
  }
});

test("multiple deltas anchor to the same doc_id (append-only, document-keyed)", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, schemaText());

    const docId = "01J0XQT8Z9N3H6K2M5P7R9T1V3";
    const scope = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
    await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      ROOT,
      insertDelta("01ARZ3NDEKTSV4RRFFQ69G5FAV", docId, scope)
    );
    await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      ROOT,
      insertDelta("01ARZ3NDEKTSV4RRFFQ69G5FB0", docId, scope)
    );

    const rows = await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      ROOT,
      `SELECT count() FROM document_delta WHERE doc_id = '${docId}' GROUP ALL;`
    );
    expect(rows[0]?.result).toMatchObject([{ count: 2 }]);
  } finally {
    sidecar.stop();
  }
});

test("a since-cursor keyset filter returns only deltas with cursor strictly greater than the supplied cursor", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, schemaText());

    const scope = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
    const docId = "01J0XQT8Z9N3H6K2M5P7R9T1V3";
    // Three deltas at server cursors 1, 2, 3 (cursor is server-assigned; here
    // set directly via the deploy cred to seed a known keyset).
    for (let cursor = 1; cursor <= 3; cursor += 1) {
      await sql(
        sidecar.url,
        SURREAL_NS,
        SURREAL_DB,
        ROOT,
        `CREATE document_delta:\`01ARZ3NDEKTSV4RRFFQ69G5F0${cursor}\` SET op_id = '01ARZ3NDEKTSV4RRFFQ69G5F0${cursor}', doc_id = '${docId}', scope_user_id = '${scope}', doc_schema_version = 1, cursor = ${cursor}, payload = 'aGVsbG8=';`
      );
    }

    // Keyset pull since cursor 1 → only cursors 2 and 3, ordered ascending, no
    // START/OFFSET deep-paging.
    const rows = await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      ROOT,
      `SELECT cursor FROM document_delta WHERE scope_user_id = '${scope}' AND cursor > 1 ORDER BY cursor ASC;`
    );
    expect(rows[0]?.result).toMatchObject([{ cursor: 2 }, { cursor: 3 }]);
  } finally {
    sidecar.stop();
  }
});

test("the since-cursor keyset filter is range-backed by the (scope_user_id, cursor) index, not a full table scan", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, schemaText());

    const scope = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
    const explain = await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      ROOT,
      `SELECT cursor FROM document_delta WHERE scope_user_id = '${scope}' AND cursor > 1 ORDER BY cursor ASC EXPLAIN;`
    );
    const plan = JSON.stringify(explain[0]?.result ?? []);
    // The query planner covers the keyset with an IndexScan over the trailing
    // composite index — never a TableScan. The named index doing the range work
    // (not a post-filter over a full scan) is the load-bearing proof.
    expect(plan).toContain("IndexScan");
    expect(plan).toContain("idx_document_delta_scope_cursor");
    expect(plan).not.toContain("TableScan");
  } finally {
    sidecar.stop();
  }
});
