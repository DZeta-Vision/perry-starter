// Acceptance proofs for the SurrealDB row-level (second) leg of the audit
// perimeter, against a live hardened loopback `surreal` sidecar, plus the two-layer
// read. The merged `.surql` schema is applied via the bootstrap root cred (DDL
// only); every subsequent read/write runs through a scoped record-access Bearer
// session, so the row-level PERMISSIONS are real. Serialize sidecar-backed tests
// (known sidecar flake under concurrency); top-level static imports are the audit
// module (same package) + vitest — the surreal client is imported dynamically.
//
// Behavior asserted (names describe behavior, not a planning id):
//  - a superadmin can NEITHER update NOR delete an audit row (append-only holds for
//    every role incl. superadmin); the rows remain intact after the attempts
//  - an arbitrary authenticated member session cannot append a forged audit row
//  - a member session reads ZERO audit rows (no trail leak) — and is also denied at
//    the tRPC middleware layer (two-layer), while an admin reads the keyset page
//  - the action vocabulary ASSERT rejects an out-of-vocabulary action at write time

import { describe, expect, test } from "vitest";
import {
  buildAuditKeysetSql,
  buildAuditWriteSql,
  createAuditReadCaller,
  mapAuditRow,
} from "../src/audit-log";

const LOOPBACK = "127.0.0.1";
const ROOT_USER = "root";
const ROOT_PASS = "root_secret_for_test_only";
const SIDECAR_PORT = 18_071; // distinct from the other sidecar ports in the suite
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;
const SURREAL_NS = "perry";
const SURREAL_DB = "perry";

const ULID_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ULID_B = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const ULID_C = "01J0XQT8Z9N3H6K2M5P7R9T1V3";

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
        return { url, stop: () => proc.kill() };
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
  return { sql: mod.sql as Sql, signin: mod.signinRecord as SigninRecord };
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

const seedEntry = (id: string, action: string) =>
  buildAuditWriteSql(id, {
    action,
    actor: "user:system",
    actor_email: "system@example.com",
    actor_role: "superadmin",
    target_type: "session",
    target_id: "session:1",
    metadata: { reason: "password" },
    ip: "127.0.0.1",
    user_agent: "Mozilla/5.0 (X11; 'quoted')",
  });

const auditCount = async (sql: Sql, url: string): Promise<number> => {
  const rows = await sql(
    url,
    SURREAL_NS,
    SURREAL_DB,
    ROOT,
    "SELECT count() FROM audit_log GROUP ALL;"
  );
  const first = (rows[0]?.result as { count?: number }[] | undefined)?.[0];
  return first?.count ?? 0;
};

describe("the audit trail is append-only and admin-scoped at the SurrealDB row layer", () => {
  test("superadmin cannot update or delete rows, a member cannot append or read, an admin reads the keyset page, and an out-of-vocabulary action is rejected", async () => {
    const sidecar = await startMemorySidecar();
    try {
      const { sql, signin } = await loadSurreal();
      const schema = await readSchema();
      await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, schema);

      // The action vocabulary ASSERT rejects an out-of-vocabulary domain at write
      // time: `billing` is not in the closed set, so the per-statement status is ERR
      // (surfaced as a throw) and no row is written.
      await expect(
        sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          ROOT,
          "CREATE type::record('audit_log', '01D78XYFJ1PRM1WPBCBT3VHMNW') SET action = 'billing.charge', actor = 'x', actor_email = 'a@example.com', actor_role = 'member', target_type = 't', target_id = 'i', metadata = {}, ip = '1', user_agent = 'u';"
        )
      ).rejects.toThrow();
      expect(await auditCount(sql, sidecar.url)).toBe(0);

      // Three system-level appends via the privileged root context (bypasses row
      // PERMISSIONS — the system-write path), built by the real write builder.
      for (const [id, action] of [
        [ULID_A, "auth.sign_in"],
        [ULID_B, "admin.role_change"],
        [ULID_C, "session.revoked"],
      ] as const) {
        const { query, vars } = seedEntry(id, action);
        await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, query, vars);
      }
      expect(await auditCount(sql, sidecar.url)).toBe(3);

      const memberTok = await signin(sidecar.url, {
        ac: "account",
        db: SURREAL_DB,
        email: "member@example.com",
        ns: SURREAL_NS,
        pass: "member-pass-1234",
        role: "member",
      });
      const adminTok = await signin(sidecar.url, {
        ac: "account",
        db: SURREAL_DB,
        email: "admin@example.com",
        ns: SURREAL_NS,
        pass: "admin-pass-1234",
        role: "admin",
      });
      const superTok = await signin(sidecar.url, {
        ac: "account",
        db: SURREAL_DB,
        email: "super@example.com",
        ns: SURREAL_NS,
        pass: "super-pass-1234",
        role: "superadmin",
      });

      // A superadmin scoped session cannot rewrite or clear the trail — FOR update,
      // delete NONE holds for EVERY role. The statements run (no error) but affect
      // nothing, and the rows survive intact.
      const superAuth: SqlAuth = { kind: "bearer", token: superTok };
      const updated = await sql(
        sidecar.url,
        SURREAL_NS,
        SURREAL_DB,
        superAuth,
        "UPDATE audit_log SET action = 'admin.tamper';"
      );
      expect(updated[0]?.result).toEqual([]);
      const deleted = await sql(
        sidecar.url,
        SURREAL_NS,
        SURREAL_DB,
        superAuth,
        "DELETE audit_log;"
      );
      expect(deleted[0]?.result).toEqual([]);
      expect(await auditCount(sql, sidecar.url)).toBe(3);

      // An arbitrary authenticated member session cannot append a forged event: the
      // CREATE is denied by the row-level FOR create grant (nothing is written).
      const memberAuth: SqlAuth = { kind: "bearer", token: memberTok };
      const forged = await sql(
        sidecar.url,
        SURREAL_NS,
        SURREAL_DB,
        memberAuth,
        "CREATE type::record('audit_log', '01D78XYFJ1PRM1WPBCBT3VHMNV') SET action = 'admin.forged', actor = 'user:m', actor_email = 'm@example.com', actor_role = 'member', target_type = 't', target_id = 'i', metadata = {}, ip = '1', user_agent = 'u';"
      );
      expect(forged[0]?.result).toEqual([]);
      expect(await auditCount(sql, sidecar.url)).toBe(3);

      // A member reads ZERO rows at the row layer (no trail leak)...
      const memberReads = await sql(
        sidecar.url,
        SURREAL_NS,
        SURREAL_DB,
        memberAuth,
        "SELECT * FROM audit_log;"
      );
      expect(memberReads[0]?.result).toEqual([]);

      // ...and is ALSO denied at the tRPC middleware layer (two-layer perimeter).
      const captured = await createAuditReadCaller({
        readAuditEntries: () => Promise.resolve([]),
        session: { user: { id: "user:m", role: "member" } },
      })
        .list({ limit: 50 })
        .then(() => "granted")
        .catch(() => "denied");
      expect(captured).toBe("denied");

      // An admin reads the keyset page (newest-first, no OFFSET) and every row maps
      // to a valid canonical entry.
      const adminAuth: SqlAuth = { kind: "bearer", token: adminTok };
      const page = await sql(
        sidecar.url,
        SURREAL_NS,
        SURREAL_DB,
        adminAuth,
        buildAuditKeysetSql({ limit: 10 })
      );
      const rows = page[0]?.result as Record<string, unknown>[];
      expect(rows).toHaveLength(3);
      const entries = rows.map(mapAuditRow);
      // Newest-first: id DESC over the time-sortable ULIDs (C > B > A).
      expect(entries.map((entry) => entry.id)).toEqual([
        ULID_C,
        ULID_B,
        ULID_A,
      ]);
    } finally {
      sidecar.stop();
    }
  });
});
