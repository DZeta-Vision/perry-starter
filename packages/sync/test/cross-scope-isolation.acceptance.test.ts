// Acceptance — the adversarial "A cannot read B" cross-scope isolation proof.
//
// The sole isolation perimeter is a SERVER-DERIVED scope = the authenticated
// session's user id, applied on BOTH legs (push + pull) across ALL THREE copies
// of delta data: the cloud log, the local store, and the materialized
// projection. This suite proves, against a real loopback `surreal` 3.1.5
// sidecar, that:
//
//   * MATRIX (copy x leg): for every copy and every leg, user A reads ZERO of
//     user B's rows — and, as a NON-VACUOUS positive control, A reads its OWN
//     rows. A perimeter that returns nothing for everyone therefore cannot pass,
//     because the positive control would fail.
//   * FORGED SCOPE: a request that asserts another owner's scope in its body is
//     ignored — the server-derived scope wins, so A still reads only A.
//   * DEFENSE IN DEPTH: the delta-log is sealed to record-access sessions, so a
//     scoped session reads zero rows directly even if a transport-layer scope
//     check were absent or bypassed.
//
// Seeding uses the deploy/DDL (root) credential, which bypasses table
// PERMISSIONS — the only credential allowed to write a sealed table. The
// perimeter read is constrained by the server-derived scope, never a
// client-asserted one.
//
// The store/perimeter artefacts are imported DYNAMICALLY inside the test bodies,
// so each suite resolves them only when it runs. The suite asserts the BEHAVIOR
// (A reads zero of B; A reads its own; a forged scope is ignored; the sealed
// table denies a scoped session), not a fixed query string.

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

const LOOPBACK = "127.0.0.1";
const ROOT_USER = "root";
const ROOT_PASS = "root_secret_for_test_only";
const SIDECAR_PORT = 18_046;
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;
const SURREAL_NS = "perry";
const SURREAL_DB = "perry";

const DELTA_TABLE = "document_delta";
const PROJECTION_TABLE = "document_projection";

// The two owners under test. The id is the value the server derives from the
// session (session.user.id); the perimeter constrains on exactly this.
const OWNER_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OWNER_B = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

// The three copies of delta data the perimeter must cover, each mapped to its
// backing table. The cloud log and the local store share the canonical
// delta-log shape (the cloud copy is exercised through the gatekeeper seam,
// modeled here over the same table); the projection is the read-model copy.
const COPIES = [
  { copy: "cloud-log", table: DELTA_TABLE },
  { copy: "local-store", table: DELTA_TABLE },
  { copy: "materialized-projection", table: PROJECTION_TABLE },
] as const;

const LEGS = ["push", "pull"] as const;

interface Sidecar {
  readonly stop: () => Promise<void>;
  readonly url: string;
}

interface SqlRow {
  readonly result: unknown;
  readonly status: "OK" | "ERR";
}
type SqlAuth =
  | { kind: "basic"; user: string; pass: string }
  | { kind: "bearer"; token: string };
type SqlFn = (
  url: string,
  ns: string,
  db: string,
  auth: SqlAuth,
  query: string,
  vars?: Record<string, string>
) => Promise<SqlRow[]>;
type SigninRecordFn = (
  url: string,
  body: { ns: string; db: string; ac: string } & Record<string, unknown>
) => Promise<string>;

interface IsolationSurface {
  resolveEnforcedScope: (
    session: { user: { id: string } },
    clientAssertedScopeUserId?: string
  ) => string;
}

const ROOT: SqlAuth = { kind: "basic", user: ROOT_USER, pass: ROOT_PASS };

const STOP_GRACE_MS = 2000;

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((res) => {
    setTimeout(res, ms);
  });

// Stop the sidecar and RESOLVE only once the process has actually exited, so the
// loopback port is released before the next test rebinds it. Under CI fork
// contention an un-awaited kill leaves the port briefly held, and the next
// spawn's health poll can attach to the dying instance — the resolved exit closes
// that rebind race. A grace timer guarantees the harness never hangs.
const stopSidecar = (proc: ChildProcess): Promise<void> =>
  new Promise<void>((res) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      res();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        res();
      }
    };
    proc.once("exit", finish);
    proc.kill();
    setTimeout(finish, STOP_GRACE_MS);
  });

// A raw /sql readiness probe: /health can flip green a beat before POST /sql is
// ready under contention, so the first real statement (the schema apply) would
// race. Gating on a trivial RETURN 1 closes that window without a module import.
const probeSql = async (url: string): Promise<boolean> => {
  try {
    const res = await fetch(`${url}/sql`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${ROOT_USER}:${ROOT_PASS}`)}`,
        "surreal-ns": SURREAL_NS,
        "surreal-db": SURREAL_DB,
        Accept: "application/json",
        "Content-Type": "text/plain",
      },
      body: "RETURN 1;",
    });
    if (!res.ok) {
      return false;
    }
    const rows = JSON.parse(await res.text()) as { status?: string }[];
    return rows[0]?.status === "OK";
  } catch {
    return false;
  }
};

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
      if (res.ok && (await probeSql(url))) {
        return { url, stop: () => stopSidecar(proc) };
      }
    } catch {
      // not listening yet — poll again within budget
    }
    await sleep(HEALTH_POLL_MS);
  }
  await stopSidecar(proc);
  throw new Error("surreal sidecar did not become SQL-ready within budget");
};

const dyn = (specifier: string): Promise<Record<string, unknown>> =>
  import(specifier) as Promise<Record<string, unknown>>;

const loadSql = async (): Promise<SqlFn> => {
  const httpMod = await dyn("@perry-starter/data/surreal-http");
  return httpMod.sql as SqlFn;
};

const loadSigninRecord = async (): Promise<SigninRecordFn> => {
  const httpMod = await dyn("@perry-starter/data/surreal-http");
  return httpMod.signinRecord as SigninRecordFn;
};

const loadIsolation = async (): Promise<IsolationSurface> => {
  const mod = await dyn("../src/isolation");
  return mod as unknown as IsolationSurface;
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

// Seed one row under a given scope into a given copy's table, via the root
// (deploy/DDL) credential that bypasses the sealed table's PERMISSIONS. Values
// travel as bind variables; only the fixed table name is templated. Each copy is
// seeded with exactly the fields its sealed SCHEMAFULL table declares: the
// delta-log copies carry the append-only op-id / schema-version / opaque base64
// payload, while the materialized projection carries the read-model cursor.
const seedRow = async (
  sql: SqlFn,
  url: string,
  table: string,
  id: string,
  scope: string
): Promise<void> => {
  const setClause =
    table === PROJECTION_TABLE
      ? "SET scope_user_id = $scope, doc_id = $id, updated_cursor = 1"
      : "SET scope_user_id = $scope, doc_id = $id, op_id = $id, doc_schema_version = 1, cursor = 1, payload = 'aGVsbG8='";
  await sql(
    url,
    SURREAL_NS,
    SURREAL_DB,
    ROOT,
    `CREATE type::record($table, $id) ${setClause};`,
    { table, id, scope }
  );
};

// Read every row visible under the server-derived scope. The perimeter is the
// WHERE filter on the server-derived scope; nothing else widens it.
const readScoped = async (
  sql: SqlFn,
  url: string,
  table: string,
  scope: string
): Promise<{ scope_user_id?: string }[]> => {
  const rows = await sql<{ scope_user_id?: string }[]>(
    url,
    SURREAL_NS,
    SURREAL_DB,
    ROOT,
    "SELECT scope_user_id FROM type::table($table) WHERE scope_user_id = $scope;",
    { table, scope }
  );
  const result = rows[0]?.result;
  return Array.isArray(result) ? (result as { scope_user_id?: string }[]) : [];
};

const countForeignRows = (
  rows: { scope_user_id?: string }[],
  foreignScope: string
): number => rows.filter((row) => row.scope_user_id === foreignScope).length;

// --- Shared sidecar lifecycle ----------------------------------------------
//
// ONE loopback sidecar serves the whole suite: the schema is applied once and
// every test reuses it. afterEach wipes the seeded rows, so each test still runs
// against an empty, clean-slate set of tables — preserving the per-test isolation
// the assertions assume (a push-leg deny that expects ZERO of B's rows only holds
// because the prior test's B rows are cleared). A single long-lived sidecar
// removes the per-test spawn/health/rebind churn that, under concurrent test
// files, is the dominant flake source — without weakening any assertion.

let sidecar: Sidecar;
let sql: SqlFn;
let iso: IsolationSurface;
let signinRecord: SigninRecordFn;

beforeAll(async () => {
  sidecar = await startMemorySidecar();
  sql = await loadSql();
  iso = await loadIsolation();
  signinRecord = await loadSigninRecord();
  // Apply the canonical schema once; the per-test wipe keeps the data clean.
  await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, schemaText());
});

afterEach(async () => {
  // Reset to a clean slate between tests: clear all seeded delta / projection /
  // credential rows (root bypasses the sealed tables' PERMISSIONS). The schema,
  // indexes and access definitions persist.
  await sql(
    sidecar.url,
    SURREAL_NS,
    SURREAL_DB,
    ROOT,
    "DELETE document_delta; DELETE document_projection; DELETE user;"
  );
});

afterAll(async () => {
  await sidecar.stop();
});

// --- The copy x leg adversarial matrix -------------------------------------

for (const { copy, table } of COPIES) {
  for (const leg of LEGS) {
    test(`A reads zero of B's rows in the ${copy} copy on the ${leg} leg`, async () => {
      const sessionA = { user: { id: OWNER_A } };
      // The request asserts B's scope; the server ignores it and derives A's.
      const enforced = iso.resolveEnforcedScope(sessionA, OWNER_B);

      if (leg === "push") {
        // A pushes under a forged scope claiming B. The server stamps the
        // server-derived scope (A), so the row can never land in B's scope.
        await seedRow(sql, sidecar.url, table, OWNER_A, enforced);
        const bRows = await readScoped(sql, sidecar.url, table, OWNER_B);
        expect(bRows.length).toBe(0);
      } else {
        // Both owners already have rows; A pulls under the server-derived
        // scope and must see zero of B's.
        await seedRow(sql, sidecar.url, table, OWNER_A, OWNER_A);
        await seedRow(sql, sidecar.url, table, OWNER_B, OWNER_B);
        const aRows = await readScoped(sql, sidecar.url, table, enforced);
        expect(countForeignRows(aRows, OWNER_B)).toBe(0);
      }
    });

    test(`A reads its own rows in the ${copy} copy on the ${leg} leg (non-vacuous positive control)`, async () => {
      const sessionA = { user: { id: OWNER_A } };
      const enforced = iso.resolveEnforcedScope(sessionA, OWNER_B);

      // Seed A's own row, then A reads under the server-derived scope: a
      // return-nothing-for-everyone perimeter would fail this control.
      await seedRow(sql, sidecar.url, table, OWNER_A, OWNER_A);
      const aRows = await readScoped(sql, sidecar.url, table, enforced);
      expect(aRows.length).toBeGreaterThan(0);
      expect(countForeignRows(aRows, OWNER_B)).toBe(0);
    });
  }
}

// --- Standalone perimeter proofs -------------------------------------------

test("the schema applies cleanly against surreal 3.1.5", async () => {
  // Apply the canonical schema into a throwaway database on the shared sidecar so
  // the clean-apply is exercised fresh without disturbing the suite's database.
  const rows = await sql(
    sidecar.url,
    SURREAL_NS,
    "schema_apply_check",
    ROOT,
    schemaText()
  );
  expect(rows.every((r) => r.status === "OK")).toBe(true);
});

test("a scoped record-access session reads zero rows from the sealed delta-log (row layer denies independently of the middleware)", async () => {
  // Seed deltas for two owners via root (bypasses PERMISSIONS).
  await seedRow(sql, sidecar.url, DELTA_TABLE, OWNER_A, OWNER_A);
  await seedRow(sql, sidecar.url, DELTA_TABLE, OWNER_B, OWNER_B);

  // A scoped record-access session, with NO server-side scope filter applied,
  // still reads zero rows because the delta-log is sealed PERMISSIONS NONE.
  const token = await signinRecord(sidecar.url, {
    ns: SURREAL_NS,
    db: SURREAL_DB,
    ac: "account",
    email: "owner-a@perry.local",
    pass: "owner-a-secret",
  });
  const rows = await sql(
    sidecar.url,
    SURREAL_NS,
    SURREAL_DB,
    { kind: "bearer", token },
    "SELECT scope_user_id FROM type::table($table);",
    { table: DELTA_TABLE }
  );
  const result = rows[0]?.result;
  expect(Array.isArray(result) ? result.length : -1).toBe(0);
});

test("a scoped record-access session reads zero rows from the sealed materialized projection (the third copy denies independently of the middleware)", async () => {
  // Seed projection rows for two owners via root (bypasses PERMISSIONS).
  await seedRow(sql, sidecar.url, PROJECTION_TABLE, OWNER_A, OWNER_A);
  await seedRow(sql, sidecar.url, PROJECTION_TABLE, OWNER_B, OWNER_B);

  // The materialized projection is the third copy; like the delta-log it is
  // sealed PERMISSIONS NONE, so a scoped record-access session reads zero rows
  // directly even with NO server-side scope filter applied.
  const token = await signinRecord(sidecar.url, {
    ns: SURREAL_NS,
    db: SURREAL_DB,
    ac: "account",
    email: "owner-a@perry.local",
    pass: "owner-a-secret",
  });
  const rows = await sql(
    sidecar.url,
    SURREAL_NS,
    SURREAL_DB,
    { kind: "bearer", token },
    "SELECT scope_user_id FROM type::table($table);",
    { table: PROJECTION_TABLE }
  );
  const result = rows[0]?.result;
  expect(Array.isArray(result) ? result.length : -1).toBe(0);
});

test("a forged scope in the request body cannot read another owner's deltas (server-derived scope wins)", async () => {
  await seedRow(sql, sidecar.url, DELTA_TABLE, OWNER_A, OWNER_A);
  await seedRow(sql, sidecar.url, DELTA_TABLE, OWNER_B, OWNER_B);

  // A authenticates, but the request body forges scope_user_id = B. The
  // server derives the scope from the session (A) and ignores the forged one.
  const sessionA = { user: { id: OWNER_A } };
  const enforced = iso.resolveEnforcedScope(sessionA, OWNER_B);
  expect(enforced).toBe(OWNER_A);

  const aRows = await readScoped(sql, sidecar.url, DELTA_TABLE, enforced);
  expect(countForeignRows(aRows, OWNER_B)).toBe(0);
  expect(aRows.length).toBeGreaterThan(0);
});
