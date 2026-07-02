// Acceptance proofs for the admin user-management surface against a live hardened
// loopback `surreal` sidecar: the index-backed keyset read plan-shape, the
// two-layer superadmin-only role-assignment enforcement at the SurrealDB row layer,
// and the reversible (soft) deactivate. The merged `.surql` schema is applied via
// the bootstrap root cred (DDL only); the two-layer proof drives a scoped
// record-access Bearer session so the row-level PERMISSIONS are real. Serialize
// sidecar-backed tests (known sidecar flake under concurrency); top-level static
// imports are the user-admin builders (same package) + the auth rbac projection +
// vitest — the surreal client is imported dynamically.
//
// Behavior asserted (names describe behavior, not a planning id):
//  - the status-scoped keyset is an IndexScan over the named composite index, never
//    a TableScan (no OFFSET deep-paging)
//  - a scoped non-superadmin session cannot escalate a user's role at the row layer
//    (the sealed user table denies the write); the privileged system path can, so a
//    role change is confined to the system forwarder — and the row-leg escalation
//    predicate resolves to superadmin-only
//  - a deactivate is a SOFT status flip: the row survives (recoverable) and a
//    reactivate restores it — never a hard delete

import {
  roleAssignmentEscalationPredicate,
  roleAssignmentTiers,
} from "@perry-starter/auth/rbac";
import { describe, expect, test } from "vitest";
import {
  buildDeactivateSql,
  buildReactivateSql,
  buildUserListKeysetSql,
} from "../src/user-admin";

const LOOPBACK = "127.0.0.1";
const ROOT_USER = "root";
const ROOT_PASS = "root_secret_for_test_only";
const SIDECAR_PORT = 18_081; // distinct from the other sidecar ports in the suite
const HEALTH_POLL_MS = 100;
// A generous health budget so a slow sidecar spawn under multi-file CI contention
// (many acceptance suites spawn a sidecar at once) does not spuriously time out;
// the budget sits well under the node project's 30 s test timeout.
const HEALTH_MAX_ATTEMPTS = 120;
const SURREAL_NS = "perry";
const SURREAL_DB = "perry";

interface Sidecar {
  readonly stop: () => void;
  readonly url: string;
}
type SqlAuth =
  | { kind: "basic"; pass: string; user: string }
  | { kind: "bearer"; token: string };
interface SqlRow {
  readonly result: unknown;
  readonly status: "ERR" | "OK";
}
type Sql = (
  url: string,
  ns: string,
  db: string,
  auth: SqlAuth,
  query: string,
  vars?: Record<string, string>
) => Promise<SqlRow[]>;
type SigninRecord = (
  url: string,
  body: { ac: string; db: string; ns: string } & Record<string, unknown>
) => Promise<string>;

const TRAILING_SEMICOLON_RE = /;\s*$/;

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const startMemorySidecar = async (): Promise<Sidecar> => {
  const { spawn } = await import("node:child_process");
  const proc = spawn(
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
        return { stop: () => proc.kill(), url };
      }
    } catch {
      // sidecar not listening yet — poll again within budget
    }
    await sleep(HEALTH_POLL_MS);
  }
  proc.kill();
  throw new Error("surreal sidecar did not pass /health within budget");
};

const loadSurreal = async (): Promise<{ sql: Sql; signin: SigninRecord }> => {
  const mod = (await import("@perry-starter/data/surreal-http")) as Record<
    string,
    unknown
  >;
  return { signin: mod.signinRecord as SigninRecord, sql: mod.sql as Sql };
};

const readSchema = async (): Promise<string> => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  return readFileSync(
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
};

const ROOT: SqlAuth = { kind: "basic", pass: ROOT_PASS, user: ROOT_USER };

const userCount = async (sql: Sql, url: string): Promise<number> => {
  const rows = await sql(
    url,
    SURREAL_NS,
    SURREAL_DB,
    ROOT,
    "SELECT count() FROM user GROUP ALL;"
  );
  const first = (rows[0]?.result as { count?: number }[] | undefined)?.[0];
  return first?.count ?? 0;
};

const roleOf = async (
  sql: Sql,
  url: string,
  id: string
): Promise<string | undefined> => {
  const rows = await sql(
    url,
    SURREAL_NS,
    SURREAL_DB,
    ROOT,
    `SELECT role FROM type::record('user', '${id}');`
  );
  return (rows[0]?.result as { role?: string }[] | undefined)?.[0]?.role;
};

const statusOf = async (
  sql: Sql,
  url: string,
  id: string
): Promise<string | undefined> => {
  const rows = await sql(
    url,
    SURREAL_NS,
    SURREAL_DB,
    ROOT,
    `SELECT status FROM type::record('user', '${id}');`
  );
  return (rows[0]?.result as { status?: string }[] | undefined)?.[0]?.status;
};

describe("the admin user surface is keyset-index-backed, superadmin-only at the row layer, and softly reversible", () => {
  test("the status-scoped keyset EXPLAINs to an IndexScan over the named index, a scoped non-superadmin cannot escalate a role, and a deactivate is a recoverable soft flip", async () => {
    const sidecar = await startMemorySidecar();
    try {
      const { sql, signin } = await loadSurreal();
      const schema = await readSchema();
      await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, schema);

      // Two seed users the admin surface will list / act on.
      await sql(
        sidecar.url,
        SURREAL_NS,
        SURREAL_DB,
        ROOT,
        "CREATE user:alice SET email = 'alice@example.com', pass = 'h', role = 'member';"
      );
      await sql(
        sidecar.url,
        SURREAL_NS,
        SURREAL_DB,
        ROOT,
        "CREATE user:bob SET email = 'bob@example.com', pass = 'h', role = 'admin';"
      );
      expect(await userCount(sql, sidecar.url)).toBe(2);

      // The status-scoped keyset (built by the shipped builder) is an index-backed
      // range walk over the trailing (status, created_at) composite — never a
      // TableScan, never an OFFSET/START deep-page.
      const { query, vars } = buildUserListKeysetSql({
        cursor: "2030-01-01T00:00:00Z",
        limit: 50,
        status: "active",
      });
      const explain = await sql(
        sidecar.url,
        SURREAL_NS,
        SURREAL_DB,
        ROOT,
        `${query.replace(TRAILING_SEMICOLON_RE, "")} EXPLAIN;`,
        vars
      );
      const plan = JSON.stringify(explain[0]?.result ?? []);
      expect(plan).toContain("IndexScan");
      expect(plan).toContain("idx_user_status_created");
      expect(plan).not.toContain("TableScan");

      // The shipped keyset read returns the seeded rows through the index path.
      const page = await sql(
        sidecar.url,
        SURREAL_NS,
        SURREAL_DB,
        ROOT,
        buildUserListKeysetSql({ limit: 50, status: "active" }).query,
        { status: "active" }
      );
      expect((page[0]?.result as unknown[]).length).toBe(2);

      // Two-layer, row leg: a scoped non-superadmin (admin) record-access session
      // cannot escalate a user's role — the sealed user table denies the write, so
      // the statement affects nothing and the role is unchanged. This is the DB
      // floor under the tRPC superadmin gate: no non-superadmin can escalate.
      const adminTok = await signin(sidecar.url, {
        ac: "account",
        db: SURREAL_DB,
        email: "scoped-admin@example.com",
        ns: SURREAL_NS,
        pass: "admin-pass-1234",
        role: "admin",
      });
      const adminAuth: SqlAuth = { kind: "bearer", token: adminTok };
      const escalated = await sql(
        sidecar.url,
        SURREAL_NS,
        SURREAL_DB,
        adminAuth,
        "UPDATE user:alice SET role = 'superadmin';"
      );
      expect(escalated[0]?.result).toEqual([]);
      expect(await roleOf(sql, sidecar.url, "alice")).toBe("member");

      // The privileged system path (root, which bypasses row PERMISSIONS) is the
      // ONLY writer that can change a role — a role change is confined to the system
      // forwarder that the tRPC superadmin gate authorizes.
      await sql(
        sidecar.url,
        SURREAL_NS,
        SURREAL_DB,
        ROOT,
        "UPDATE user:alice SET role = 'admin';"
      );
      expect(await roleOf(sql, sidecar.url, "alice")).toBe("admin");

      // The row-leg escalation authority resolves to superadmin-only, derived from
      // the one matrix (parity with the tRPC leg).
      expect(roleAssignmentTiers()).toEqual(["superadmin"]);
      expect(roleAssignmentEscalationPredicate()).toContain("'superadmin'");
      expect(roleAssignmentEscalationPredicate()).not.toContain("'member'");

      // Reversible deactivate: a SOFT status flip. The row survives (the user
      // count is UNCHANGED — never a hard delete) and a reactivate restores access.
      const countBefore = await userCount(sql, sidecar.url);
      const deactivate = buildDeactivateSql("alice");
      await sql(
        sidecar.url,
        SURREAL_NS,
        SURREAL_DB,
        ROOT,
        deactivate.query,
        deactivate.vars
      );
      expect(await statusOf(sql, sidecar.url, "alice")).toBe("deactivated");
      expect(await userCount(sql, sidecar.url)).toBe(countBefore);

      const reactivate = buildReactivateSql("alice");
      await sql(
        sidecar.url,
        SURREAL_NS,
        SURREAL_DB,
        ROOT,
        reactivate.query,
        reactivate.vars
      );
      expect(await statusOf(sql, sidecar.url, "alice")).toBe("active");
      expect(await userCount(sql, sidecar.url)).toBe(countBefore);
    } finally {
      sidecar.stop();
    }
  });
});
