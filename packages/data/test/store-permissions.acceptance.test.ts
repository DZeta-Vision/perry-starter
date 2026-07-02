// Acceptance tests for the row-level PERMISSIONS shape of the merged schema.
//
// Verify that every owner-data table declares explicit row-level PERMISSIONS
// scoped to the authenticated record (none defaulting open); that the sealed
// tables (the `user` credential table and the `document_delta` delta-log) are
// fully denied to record-access sessions; and — against a live sidecar — that a
// scoped record-access session reads [] from `user` while sign-up and sign-in
// still succeed end to end. The merged `.surql` schema is read via `node:fs`;
// the live leg spawns a hardened loopback `surreal`.

import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const SCHEMA_DIR = join(process.cwd(), "packages", "db", "database", "schema");

// Tables intentionally sealed to record-access sessions (PERMISSIONS NONE): the
// `user` credential table (no scoped session may read another user's email /
// argon2 hash), the `document_delta` delta-log, the `document_projection`
// read-model (both delta-data copies whose cross-scope perimeter is enforced
// server-side by the server-derived scope), the `recovery_code` table (the
// break-glass code hashes are read/consumed only by the privileged system flow),
// and the `invitation` table (the single-use token digests + the role-to-stamp are
// minted/read/consumed only by the privileged system flow, and no account exists
// there before acceptance). Every OTHER user-data table must scope by $auth.
const SEALED_TABLES = new Set([
  "user",
  "document_delta",
  "document_projection",
  "recovery_code",
  "invitation",
]);

// Top-level regex literals (Biome: never build regex inside loops).
const DEFINE_TABLE_RE =
  /DEFINE\s+TABLE\s+(\w+)[\s\S]*?(?=DEFINE\s+TABLE\b|DEFINE\s+ACCESS\b|DEFINE\s+INDEX\b|$)/gi;
const SURQL_COMMENT_RE = /--[^\n]*/g;
const PERMISSIONS_RE = /\bPERMISSIONS\b/i;
const PERMISSIONS_FULL_RE = /\bPERMISSIONS\s+FULL\b/i;
const PERMISSIONS_NONE_RE = /\bPERMISSIONS\s+NONE\b/i;
const AUTH_REF_RE = /\$auth\b/i;
const GRANT_RE = /\bFOR\s+(?:select|create|update|delete)\b/i;

interface TableBlock {
  readonly body: string;
  readonly name: string;
}

const readMergedSchema = (): string => {
  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".surql"));
  return files.map((f) => readFileSync(join(SCHEMA_DIR, f), "utf8")).join("\n");
};

const parseTableBlocks = (schema: string): TableBlock[] => {
  const blocks: TableBlock[] = [];
  // Strip SurrealQL line comments first so prose like "DEFINE TABLE foo" inside a
  // comment can never be mistaken for a real table declaration.
  const code = schema.replace(SURQL_COMMENT_RE, "");
  for (const match of code.matchAll(DEFINE_TABLE_RE)) {
    blocks.push({ name: match[1], body: match[0] });
  }
  return blocks;
};

test("every owner-data DEFINE TABLE carries explicit $auth-scoped row-level PERMISSIONS — none default open", () => {
  const schema = readMergedSchema();
  const tables = parseTableBlocks(schema);

  // There must be at least the `documents` owner-data table to assert against.
  expect(tables.length).toBeGreaterThan(0);

  for (const table of tables) {
    // Sealed tables are covered separately; every OTHER user-data table must
    // carry explicit $auth-scoped PERMISSIONS.
    if (SEALED_TABLES.has(table.name)) {
      continue;
    }
    // A DEFINE TABLE with no PERMISSIONS clause (table defaults open) fails.
    expect(PERMISSIONS_RE.test(table.body)).toBe(true);
    // A `PERMISSIONS FULL` (open to every record user) fails.
    expect(PERMISSIONS_FULL_RE.test(table.body)).toBe(false);
    // The clause must scope by the authenticated record (`$auth`), not a
    // blanket grant.
    expect(AUTH_REF_RE.test(table.body)).toBe(true);
  }
});

test("the user credential table declares an explicit PERMISSIONS NONE clause — sealed to record-access sessions", () => {
  const schema = readMergedSchema();
  const tables = parseTableBlocks(schema);
  const user = tables.find((t) => t.name === "user");

  // The credential table must be defined explicitly (not left to the implicit
  // default created by the access SIGNUP / the unique email index), and must be
  // fully denied to scoped sessions so one user cannot read another's row.
  expect(user).toBeDefined();
  const body = (user as TableBlock).body;
  expect(PERMISSIONS_RE.test(body)).toBe(true);
  expect(PERMISSIONS_NONE_RE.test(body)).toBe(true);
  // No `FOR select/create/update/delete` grant leaks access to record users.
  expect(GRANT_RE.test(body)).toBe(false);
});

test("the document_delta table is PERMISSIONS NONE-shaped — no select/create/update/delete granted to record users", () => {
  const schema = readMergedSchema();
  const tables = parseTableBlocks(schema);
  const delta = tables.find((t) => t.name === "document_delta");

  // The cross-scope isolation perimeter is enforced server-side later; here
  // `document_delta` exists and denies all record-user access.
  expect(delta).toBeDefined();
  const body = (delta as TableBlock).body;

  // A `document_delta` that grants `FOR select WHERE …` (or any FOR clause) to
  // record users would fail this.
  expect(PERMISSIONS_NONE_RE.test(body)).toBe(true);
  expect(GRANT_RE.test(body)).toBe(false);
});

// --- Live leg: PERMISSIONS NONE on `user` keeps auth working but hides rows ---

const LOOPBACK = "127.0.0.1";
const ROOT_USER = "root";
const ROOT_PASS = "root_secret_for_test_only";
const SIDECAR_PORT = 18_043;
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;
const SURREAL_NS = "perry";
const SURREAL_DB = "perry";

interface Sidecar {
  readonly stop: () => void;
  readonly url: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
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
      // sidecar not listening yet — poll again within budget
    }
    await sleep(HEALTH_POLL_MS);
  }
  proc.kill();
  throw new Error("surreal sidecar did not pass /health within budget");
};

const dyn = (specifier: string): Promise<Record<string, unknown>> =>
  import(specifier) as Promise<Record<string, unknown>>;

type Sql = (
  url: string,
  ns: string,
  db: string,
  auth:
    | { kind: "basic"; user: string; pass: string }
    | { kind: "bearer"; token: string },
  query: string
) => Promise<Array<{ status: "OK" | "ERR"; result: unknown }>>;

type SigninRecord = (
  url: string,
  body: { ns: string; db: string; ac: string } & Record<string, unknown>
) => Promise<string>;

test("PERMISSIONS NONE on user keeps sign-up/sign-in working while a scoped session reads [] from user", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const httpMod = await dyn("@perry-starter/data/surreal-http");
    const sql = httpMod.sql as Sql;
    const signin = httpMod.signinRecord as SigninRecord;

    // DDL via the bootstrap root/Basic cred (privileged, bypasses PERMISSIONS).
    const basic = { kind: "basic", user: ROOT_USER, pass: ROOT_PASS } as const;
    const schemaText = readFileSync(
      join(SCHEMA_DIR, "documents.surql"),
      "utf8"
    );
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, basic, schemaText);

    // Sign-up registers Alice and Bob via the record-access flow; a token back
    // proves the access SIGNUP `CREATE user` ran despite PERMISSIONS NONE.
    const aliceToken = await signin(sidecar.url, {
      ns: SURREAL_NS,
      db: SURREAL_DB,
      ac: "account",
      email: "alice@example.com",
      pass: "alice-pass",
    });
    expect(aliceToken.length).toBeGreaterThan(0);
    const bobToken = await signin(sidecar.url, {
      ns: SURREAL_NS,
      db: SURREAL_DB,
      ac: "account",
      email: "bob@example.com",
      pass: "bob-pass",
    });
    expect(bobToken.length).toBeGreaterThan(0);

    // Sign-in on the returning identity (the unique email index routes the
    // existing user down the SIGNIN branch) still authenticates.
    const aliceReauth = await signin(sidecar.url, {
      ns: SURREAL_NS,
      db: SURREAL_DB,
      ac: "account",
      email: "alice@example.com",
      pass: "alice-pass",
    });
    expect(aliceReauth.length).toBeGreaterThan(0);

    // Alice's scoped record-access session is bound by PERMISSIONS NONE on the
    // credential table: she reads NOTHING — not her own row, and not Bob's
    // credential row. Were `user` left implicitly open, Bob's email + argon2
    // hash would leak here.
    const aliceAuth = { kind: "bearer", token: aliceToken } as const;
    const visible = await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      aliceAuth,
      "SELECT * FROM user;"
    );
    expect(visible[0].result).toEqual([]);
  } finally {
    sidecar.stop();
  }
});
