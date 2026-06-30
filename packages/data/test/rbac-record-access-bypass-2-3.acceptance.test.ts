// ATDD acceptance suite for Story 2.3 — the local-leg record-access
// scoped-credential perimeter, the root-cred NEGATIVE, role-scoped reads, audit
// write-authenticity, and the DB-layer ES256 JWT fail-closed verification.
//
// These run live: a real loopback `surreal` 3.1.5 sidecar is spawned per test
// (each on the file's single port, torn down in `finally`, so the file's tests
// serialize on one sidecar at a time). Top-level static imports are limited to
// `vitest`; the impl/schema/fixtures load dynamically inside the bodies. Reuses
// the `@perry-starter/data/surreal-http` `sql`/`signinRecord` helpers and the
// spawn/health pattern from `store-record-access.acceptance.test.ts`.
//
// `[UNVALIDATED — design-only; S11b used Basic auth]`: the behavioral contracts
// here are testable over HTTP; only the daemon-compile of the per-user/per-role
// credential-acquisition leg is design-gated.
//
// Behavior asserted (names describe behavior, never an AC/risk id):
//  - a scoped record-access Bearer session reads only its $auth-owned rows
//  - with a real audit_log row seeded, admin AND superadmin READ it (row
//    returned) while a member is DENIED (empty) — the $auth.role escalation
//    actually distinguishes granted from denied
//  - an audit-log write records the AUTHENTICATED actor; a client-supplied
//    actor_id is overwritten by the VALUE binding (no forged actor)
//  - a root/Basic system cred DOES leak a foreign row (root bypasses
//    PERMISSIONS) — proving the store must never query with root
//  - the per-request query path uses a Bearer session, never the root cred
//  - the DB-layer JWT access accepts a valid ES256 token (which reads a seeded
//    row) and rejects a tampered-signature / past-exp / wrong-alg token, which
//    can never surface that row (fail closed — not "empty either way")

import { describe, expect, test } from "vitest";

// GREEN PHASE: aliased to `test` so the intent reads at each call site.
const acceptance = test;

const LOOPBACK = "127.0.0.1";
const ROOT_USER = "root";
const ROOT_PASS = "root_secret_for_test_only";
const SIDECAR_PORT = 18_061; // distinct from the 1-3 sidecar ports (18_039/18_043)
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;
const SURREAL_NS = "perry";
const SURREAL_DB = "perry";

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
// A record-access actor id is `user:<id>`; the seeded actor must look like one.
const RECORD_ACTOR_RE = /^user:/;
const BEARER_AUTH_RE = /kind\s*:\s*["']bearer["']/;
const ROOT_CREDENTIAL_RES = [/\bSURREAL_USER\b/, /\bSURREAL_PASS\b/] as const;

interface Sidecar {
  readonly stop: () => void;
  readonly url: string;
}
type SqlAuth =
  | { kind: "basic"; pass: string; user: string }
  | { kind: "bearer"; token: string };
type Sql = (
  url: string,
  ns: string,
  db: string,
  auth: SqlAuth,
  query: string
) => Promise<Array<{ result: unknown; status: "ERR" | "OK" }>>;
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

const loadHttp = async (): Promise<{ signin: SigninRecord; sql: Sql }> => {
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

const applySchemaAsRoot = async (sql: Sql, url: string): Promise<void> => {
  const basic = { kind: "basic", user: ROOT_USER, pass: ROOT_PASS } as const;
  await sql(url, SURREAL_NS, SURREAL_DB, basic, await readSchema());
};

const signinScoped = (
  signin: SigninRecord,
  url: string,
  email: string,
  pass: string
): Promise<string> =>
  signin(url, { ns: SURREAL_NS, db: SURREAL_DB, ac: "account", email, pass });

// A unique title for the seeded owner row so "non-empty" in the ES256 contrast
// means "this specific row", never an incidental leftover.
const ES256_CANARY_TITLE = "es256-fail-closed-canary";

// Cast a per-statement result to its row array (the helper types it `unknown`).
const rowsOf = (
  rows: Array<{ result: unknown; status: "ERR" | "OK" }>
): unknown[] =>
  Array.isArray(rows[0]?.result) ? (rows[0].result as unknown[]) : [];

const bearer = (token: string) => ({ kind: "bearer", token }) as const;

// Seed exactly one owner-scoped documents row through a scoped record-access
// session (root would bypass PERMISSIONS, so it is never used to seed). The
// DB-layer JWT (`api`) session reads it back, making the valid-vs-bad ES256
// contrast a real read of a real row rather than "empty either way".
const seedDocumentCanary = async (
  sql: Sql,
  signin: SigninRecord,
  url: string
): Promise<void> => {
  const ownerToken = await signinScoped(
    signin,
    url,
    "canary-owner@example.com",
    "canary-pass"
  );
  await sql(
    url,
    SURREAL_NS,
    SURREAL_DB,
    bearer(ownerToken),
    `CREATE documents SET title = '${ES256_CANARY_TITLE}';`
  );
};

const sawCanary = (rows: unknown[]): boolean =>
  rows.some((row) => (row as { title?: string }).title === ES256_CANARY_TITLE);

describe("the local leg queries through a scoped record-access Bearer session bound by row PERMISSIONS", () => {
  acceptance(
    "a scoped session reads only its own $auth-owned row and empty for a foreign row",
    async () => {
      const sidecar = await startMemorySidecar();
      try {
        const { sql, signin } = await loadHttp();
        await applySchemaAsRoot(sql, sidecar.url);
        const aliceToken = await signinScoped(
          signin,
          sidecar.url,
          "alice@example.com",
          "alice-pass"
        );
        const bobToken = await signinScoped(
          signin,
          sidecar.url,
          "bob@example.com",
          "bob-pass"
        );
        await sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          { kind: "bearer", token: bobToken },
          "CREATE documents SET title = 'bob-secret';"
        );
        const aliceVisible = await sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          { kind: "bearer", token: aliceToken },
          "SELECT * FROM documents;"
        );
        // Bound by `owner = $auth` PERMISSIONS — Alice sees none of Bob's rows.
        expect(aliceVisible[0].result).toEqual([]);
      } finally {
        sidecar.stop();
      }
    }
  );

  acceptance(
    "a member-scoped session is denied an admin-only row while admin and superadmin sessions are granted it",
    async () => {
      const sidecar = await startMemorySidecar();
      try {
        const { sql, signin } = await loadHttp();
        await applySchemaAsRoot(sql, sidecar.url);
        // The admin/superadmin-scoped sessions (global user.role contains 'admin'
        // / 'superadmin') can read an admin-gated row; a member-scoped session
        // reads []. This exercises the $auth.role escalation clause (Story 2.3).
        const adminToken = await signin(sidecar.url, {
          ns: SURREAL_NS,
          db: SURREAL_DB,
          ac: "account",
          email: "admin@example.com",
          pass: "admin-pass",
          role: "admin",
        });
        const superadminToken = await signin(sidecar.url, {
          ns: SURREAL_NS,
          db: SURREAL_DB,
          ac: "account",
          email: "super@example.com",
          pass: "super-pass",
          role: "superadmin",
        });
        const memberToken = await signinScoped(
          signin,
          sidecar.url,
          "mallory@example.com",
          "mallory-pass"
        );
        // SEED one real audit_log row so "granted" (the row is returned) is
        // distinguishable from "denied" (empty). Without a seeded row both tiers
        // would read [] and the escalation would be untested. `FOR create FULL`
        // lets the admin session append it; actor_id is bound to $auth server-side.
        await sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          bearer(adminToken),
          "CREATE audit_log SET action = 'session.created';"
        );
        const adminSees = await sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          bearer(adminToken),
          "SELECT * FROM audit_log;"
        );
        const superadminSees = await sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          bearer(superadminToken),
          "SELECT * FROM audit_log;"
        );
        const memberSees = await sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          bearer(memberToken),
          "SELECT * FROM audit_log;"
        );
        // Granted tiers see the seeded row; the member is denied (the clause never
        // matches its $auth.role, so the SELECT yields an empty set).
        expect(rowsOf(adminSees).length).toBeGreaterThan(0);
        expect(rowsOf(superadminSees).length).toBeGreaterThan(0);
        expect(memberSees[0].result).toEqual([]);
      } finally {
        sidecar.stop();
      }
    }
  );

  acceptance(
    "an audit-log write records the authenticated actor, never a client-supplied one",
    async () => {
      const sidecar = await startMemorySidecar();
      try {
        const { sql, signin } = await loadHttp();
        await applySchemaAsRoot(sql, sidecar.url);
        // An admin both writes (FOR create FULL) and reads (escalation) the trail.
        const adminToken = await signin(sidecar.url, {
          ns: SURREAL_NS,
          db: SURREAL_DB,
          ac: "account",
          email: "auditor@example.com",
          pass: "auditor-pass",
          role: "admin",
        });
        // The writer's own authenticated record id, as the actor_id VALUE computes
        // it (type::string($auth)). $auth at statement level is the record link.
        const selfActor = await sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          bearer(adminToken),
          "RETURN type::string($auth);"
        );
        const authenticatedActor = selfActor[0].result as string;
        // Attempt to FORGE the actor: the create payload names a different actor.
        await sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          bearer(adminToken),
          "CREATE audit_log SET action = 'forge.attempt', actor_id = 'user:forged-attacker';"
        );
        const stored = await sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          bearer(adminToken),
          "SELECT actor_id FROM audit_log;"
        );
        const row = rowsOf(stored)[0] as { actor_id?: string } | undefined;
        // The forged actor_id was overwritten by the VALUE binding: the stored
        // actor is the authenticated session, not the client-supplied string.
        expect(authenticatedActor).toMatch(RECORD_ACTOR_RE);
        expect(row?.actor_id).toBe(authenticatedActor);
        expect(row?.actor_id).not.toBe("user:forged-attacker");
      } finally {
        sidecar.stop();
      }
    }
  );
});

describe("a root/OWNER system credential bypasses row PERMISSIONS — the store must never query with root", () => {
  acceptance(
    "a root/Basic cred leaks a foreign row that a scoped session cannot see",
    async () => {
      const sidecar = await startMemorySidecar();
      try {
        const { sql, signin } = await loadHttp();
        await applySchemaAsRoot(sql, sidecar.url);
        const bobToken = await signinScoped(
          signin,
          sidecar.url,
          "bob@example.com",
          "bob-pass"
        );
        await sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          { kind: "bearer", token: bobToken },
          "CREATE documents SET title = 'bob-secret';"
        );
        const bobRows = await sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          { kind: "bearer", token: bobToken },
          "SELECT id FROM documents;"
        );
        const bobDocId = (bobRows[0].result as Array<{ id: string }>)[0].id;
        // Root/Basic BYPASSES PERMISSIONS — it DOES return Bob's row. If root did
        // NOT leak, the premise of the second enforcement layer would be false.
        const leaked = await sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          { kind: "basic", user: ROOT_USER, pass: ROOT_PASS },
          `SELECT * FROM ${bobDocId};`
        );
        expect((leaked[0].result as unknown[]).length).toBe(1);
      } finally {
        sidecar.stop();
      }
    }
  );

  acceptance(
    "the per-request query path uses a Bearer record-access session and never reads the root credentials",
    async () => {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const raw = readFileSync(
        join(process.cwd(), "packages", "data", "src", "documents.local.ts"),
        "utf8"
      );
      const code = raw
        .replace(BLOCK_COMMENT_RE, "")
        .replace(LINE_COMMENT_RE, "$1");
      expect(BEARER_AUTH_RE.test(code)).toBe(true);
      expect(ROOT_CREDENTIAL_RES.some((re) => re.test(code))).toBe(false);
    }
  );
});

describe("the DB-layer ES256 JWT access verifies tokens and fails closed on bad ones", () => {
  acceptance(
    "a correctly-signed unexpired ES256 token is accepted and reads the seeded row",
    async () => {
      const sidecar = await startMemorySidecar();
      try {
        const { sql, signin } = await loadHttp();
        await applySchemaAsRoot(sql, sidecar.url);
        // SEED one real row so acceptance means "the verified token reads an
        // actual row", not the trivially-true empty-set a row-free DB returns.
        await seedDocumentCanary(sql, signin, sidecar.url);
        // A non-prod ES256 keypair + a JWT-access fixture (eventual
        // packages/test-utils) mint a valid token; the data layer accepts it.
        const tokens = (await import("@perry-starter/auth/test-jwt")) as {
          readonly mintValidEs256: () => Promise<string>;
        };
        const token = await tokens.mintValidEs256();
        const res = await sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          bearer(token),
          "SELECT * FROM documents;"
        );
        // Verified (right signature / unexpired / ES256): the statement runs and
        // returns the seeded canary — a populated, non-empty result.
        expect(res[0].status).toBe("OK");
        expect(sawCanary(rowsOf(res))).toBe(true);
      } finally {
        sidecar.stop();
      }
    }
  );

  acceptance(
    "a tampered-signature, past-exp, or wrong-algorithm token is rejected at the data layer",
    async () => {
      const sidecar = await startMemorySidecar();
      try {
        const { sql, signin } = await loadHttp();
        await applySchemaAsRoot(sql, sidecar.url);
        // SEED the canary the valid token CAN read, so the contrast is real: a
        // verified token returns the row, a rejected one must never return it.
        await seedDocumentCanary(sql, signin, sidecar.url);
        const tokens = (await import("@perry-starter/auth/test-jwt")) as {
          readonly mintValidEs256: () => Promise<string>;
          readonly mintExpiredEs256: () => Promise<string>;
          readonly mintTamperedEs256: () => Promise<string>;
          readonly mintWrongAlg: () => Promise<string>;
        };
        // Positive control IN THIS test: the valid token returns the canary, so
        // "the bad token does not return the canary" is a meaningful negative and
        // not just "the DB is empty" (the prior vacuous escape).
        const valid = await sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          bearer(await tokens.mintValidEs256()),
          "SELECT * FROM documents;"
        );
        expect(sawCanary(rowsOf(valid))).toBe(true);

        const bad = [
          await tokens.mintTamperedEs256(),
          await tokens.mintExpiredEs256(),
          await tokens.mintWrongAlg(), // EdDSA / none
        ];
        for (const token of bad) {
          // Fail closed: a tampered / expired / wrong-algorithm Bearer is rejected
          // at the transport (HTTP 401 — $auth never resolves), surfaced here as a
          // throw. Were verification broken, the token would be accepted and read
          // the seeded canary; instead it must NEVER surface the row.
          let returnedCanary = false;
          let rejected = false;
          try {
            const res = await sql(
              sidecar.url,
              SURREAL_NS,
              SURREAL_DB,
              bearer(token),
              "SELECT * FROM documents;"
            );
            rejected = res[0].status === "ERR";
            returnedCanary = sawCanary(rowsOf(res));
          } catch {
            rejected = true;
          }
          // The rejected token must not read the seeded row, and was either thrown
          // out at the transport or errored per-statement — never silently OK.
          expect(returnedCanary).toBe(false);
          expect(rejected).toBe(true);
        }
      } finally {
        sidecar.stop();
      }
    }
  );
});
