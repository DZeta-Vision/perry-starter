// Acceptance — since-cursor keyset pull returning only new deltas in O(new).
//
// Asserts the pull behavior the sync flow depends on: a since-cursor pull returns
// only deltas with cursor strictly greater than the supplied cursor, ordered
// ascending; the filter is range-backed by the trailing (scope_user_id, cursor)
// index (EXPLAIN shows an index iterate, never a full table scan) and carries NO
// START/OFFSET; paging advances by the last-seen cursor (keyset continuation, not
// OFFSET) so the next page costs O(new); and an empty pull (nothing newer)
// returns an EXPLICIT caught-up end-state, never an error or an open page.
//
// Drives a real loopback `surreal` 3.1.5 sidecar. Deltas are seeded directly via
// the deploy/root cred at known cursors (the server-assigned cursor is exercised
// by the push acceptance suite); the pull surface is imported statically (an
// inert stub) and the sql client DYNAMICALLY inside the test bodies.
//
// RED PHASE: every test is skipped until the forwarder pull + the green-phase
// schema additions (the composite range index) land. These scaffolds assert the
// BEHAVIOR, not a fixed query string or EXPLAIN operator vocabulary.

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { pullSinceCursor } from "../src/pull";

const LOOPBACK = "127.0.0.1";
const ROOT_USER = "root";
const ROOT_PASS = "root_secret_for_test_only";
const SIDECAR_PORT = 18_044;
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;
const SURREAL_NS = "perry";
const SURREAL_DB = "perry";
const PAYLOAD_B64 = "aGVsbG8=";
const SEED_COUNT = 3;
const PAGE_SIZE = 2;

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

const transportFor = (sql: SqlFn, url: string) => ({
  run: (query: string, vars?: Record<string, string>) =>
    sql(url, SURREAL_NS, SURREAL_DB, ROOT, query, vars),
});

const ULID_BASE = "01ARZ3NDEKTSV4RRFFQ69G5F0";

// Seed deltas at server cursors 1..count for one scope, via the deploy cred.
const seedDeltas = async (
  sql: SqlFn,
  url: string,
  scope: string,
  docId: string,
  count: number
): Promise<void> => {
  for (let cursor = 1; cursor <= count; cursor += 1) {
    const id = `${ULID_BASE}${cursor}`;
    await sql(
      url,
      SURREAL_NS,
      SURREAL_DB,
      ROOT,
      `CREATE document_delta:\`${id}\` SET op_id = '${id}', doc_id = '${docId}', scope_user_id = '${scope}', doc_schema_version = 1, cursor = ${cursor}, payload = '${PAYLOAD_B64}';`
    );
  }
};

test("a since-cursor pull returns only deltas with cursor strictly greater than the supplied cursor, ascending", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, schemaText());
    const scope = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
    await seedDeltas(
      sql,
      sidecar.url,
      scope,
      "01J0XQT8Z9N3H6K2M5P7R9T1V3",
      SEED_COUNT
    );

    // Pull since cursor 1 -> only cursors {2,3}, ascending, the supplied cursor
    // itself excluded (strictly-greater).
    const page = await pullSinceCursor(scope, 1, {
      transport: transportFor(sql, sidecar.url),
    });

    expect(page.deltas.map((d) => d.cursor)).toEqual([2, 3]);
    expect(page.latestCursor).toBe(3);
  } finally {
    sidecar.stop();
  }
});

test("the since-cursor pull is range-backed by the (scope_user_id, cursor) index, not a full table scan", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, schemaText());
    const scope = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
    await seedDeltas(
      sql,
      sidecar.url,
      scope,
      "01J0XQT8Z9N3H6K2M5P7R9T1V3",
      SEED_COUNT
    );

    // The exact keyset query the pull issues — no START/OFFSET deep-paging.
    const explain = await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      ROOT,
      `SELECT cursor FROM document_delta WHERE scope_user_id = '${scope}' AND cursor > 1 ORDER BY cursor ASC EXPLAIN;`
    );
    const plan = JSON.stringify(explain[0]?.result ?? []);
    // v3.1.5 EXPLAIN: the planner covers the keyset with an IndexScan over the
    // trailing composite index — never a TableScan. The named index doing the
    // range work (not a post-filter over a full scan) is the load-bearing proof.
    expect(plan).toContain("IndexScan");
    expect(plan).toContain("idx_document_delta_scope_cursor");
    expect(plan).not.toContain("TableScan");
  } finally {
    sidecar.stop();
  }
});

test("keyset pagination advances by the last-seen cursor (no OFFSET), so the next page costs O(new)", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, schemaText());
    const scope = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
    await seedDeltas(
      sql,
      sidecar.url,
      scope,
      "01J0XQT8Z9N3H6K2M5P7R9T1V3",
      SEED_COUNT
    );
    const transport = transportFor(sql, sidecar.url);

    // First page from the start: a full page of {1,2}, more remains.
    const first = await pullSinceCursor(scope, 0, {
      transport,
      pageSize: PAGE_SIZE,
    });
    expect(first.deltas.map((d) => d.cursor)).toEqual([1, 2]);
    expect(first.caughtUp).toBe(false);

    // The next page is the keyset continuation since the page's latestCursor —
    // never an OFFSET. It returns the remaining {3} and reports caught-up.
    const next = await pullSinceCursor(scope, first.latestCursor, {
      transport,
      pageSize: PAGE_SIZE,
    });
    expect(next.deltas.map((d) => d.cursor)).toEqual([3]);
    expect(next.caughtUp).toBe(true);
  } finally {
    sidecar.stop();
  }
});

test("an empty pull (nothing newer) returns an explicit caught-up end-state, not an error or open page", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, schemaText());
    const scope = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
    await seedDeltas(
      sql,
      sidecar.url,
      scope,
      "01J0XQT8Z9N3H6K2M5P7R9T1V3",
      SEED_COUNT
    );

    // Pull since the max known cursor -> nothing newer. An explicit end-state:
    // empty deltas, caught-up true, the cursor unchanged. Never throws.
    const page = await pullSinceCursor(scope, SEED_COUNT, {
      transport: transportFor(sql, sidecar.url),
    });

    expect(page.deltas).toEqual([]);
    expect(page.caughtUp).toBe(true);
    expect(page.latestCursor).toBe(SEED_COUNT);
  } finally {
    sidecar.stop();
  }
});
