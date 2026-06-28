// Acceptance tests for record-access isolation.
//
// Verify the local leg queries with a scoped record-access session that is
// bound by row-level PERMISSIONS (and so cannot read another owner's rows),
// plus the negative that a root/Basic system credential bypasses PERMISSIONS
// and does leak a foreign row — establishing why the store must never query
// with root. The impl and schema are imported/read dynamically inside the test
// bodies; a real `surreal` sidecar is spawned per test.

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const LOOPBACK = "127.0.0.1";
const ROOT_USER = "root";
const ROOT_PASS = "root_secret_for_test_only";
const SIDECAR_PORT = 18_039;
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;
const SURREAL_NS = "perry";
const SURREAL_DB = "perry";
const REPO_DATA_SRC = join(process.cwd(), "packages", "data", "src");

// Comment-resistant source guard: a bare `// Bearer ${token}` line must not
// satisfy this, and a root-cred read must not hide behind a comment. The check
// runs over comment-stripped code.
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");
const BEARER_AUTH_RE = /kind\s*:\s*["']bearer["']/;
const ROOT_CREDENTIAL_RES = [/\bSURREAL_USER\b/, /\bSURREAL_PASS\b/] as const;
const readsRootCredential = (source: string): boolean => {
  const code = stripJsComments(source);
  return ROOT_CREDENTIAL_RES.some((re) => re.test(code));
};

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

// Two scoped users own one document each; the schema is applied with the
// bootstrap root/Basic cred (DDL only).
const seedTwoScopedUsers = async (
  sql: Sql,
  signin: SigninRecord,
  url: string
): Promise<{ aliceToken: string; bobDocId: string }> => {
  const basic = { kind: "basic", user: ROOT_USER, pass: ROOT_PASS } as const;
  const schemaText = readFileSync(
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
  await sql(url, SURREAL_NS, SURREAL_DB, basic, schemaText);

  const aliceToken = await signin(url, {
    ns: SURREAL_NS,
    db: SURREAL_DB,
    ac: "account",
    email: "alice@example.com",
    pass: "alice-pass",
  });
  const bobToken = await signin(url, {
    ns: SURREAL_NS,
    db: SURREAL_DB,
    ac: "account",
    email: "bob@example.com",
    pass: "bob-pass",
  });

  await sql(
    url,
    SURREAL_NS,
    SURREAL_DB,
    { kind: "bearer", token: bobToken },
    "CREATE documents SET title = 'bob-secret';"
  );
  const bobRows = await sql(
    url,
    SURREAL_NS,
    SURREAL_DB,
    { kind: "bearer", token: bobToken },
    "SELECT id FROM documents;"
  );
  const bobDocId = (bobRows[0].result as Array<{ id: string }>)[0].id;
  return { aliceToken, bobDocId };
};

test("the local leg queries with a scoped record-access Bearer session — returns only the $auth-owned row", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const httpMod = await dyn("@perry-starter/data/surreal-http");
    const sql = httpMod.sql as Sql;
    const signin = httpMod.signinRecord as SigninRecord;

    const { aliceToken, bobDocId } = await seedTwoScopedUsers(
      sql,
      signin,
      sidecar.url
    );

    // Alice's record-access Bearer session is bound by row-level PERMISSIONS:
    // it sees ONLY her own rows and gets EMPTY for Bob's row. If PERMISSIONS
    // were absent or open, Bob's row would leak into Alice's result.
    const aliceAuth = { kind: "bearer", token: aliceToken } as const;
    const aliceVisible = await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      aliceAuth,
      "SELECT * FROM documents;"
    );
    expect(aliceVisible[0].result).toEqual([]);

    const bobRowViaAlice = await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      aliceAuth,
      `SELECT * FROM ${bobDocId};`
    );
    expect(bobRowViaAlice[0].result).toEqual([]);
  } finally {
    sidecar.stop();
  }
});

test("a root/Basic cred bypasses row-level PERMISSIONS and leaks a foreign row — proving the store must never query with root", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const httpMod = await dyn("@perry-starter/data/surreal-http");
    const sql = httpMod.sql as Sql;
    const signin = httpMod.signinRecord as SigninRecord;

    const { bobDocId } = await seedTwoScopedUsers(sql, signin, sidecar.url);

    // The root/Basic system cred BYPASSES table PERMISSIONS — it DOES return
    // Bob's row. This establishes the contract the impl must honor: never
    // query with root. If root did NOT leak the row, the premise of the
    // second enforcement layer would be false.
    const rootAuth = {
      kind: "basic",
      user: ROOT_USER,
      pass: ROOT_PASS,
    } as const;
    const leaked = await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      rootAuth,
      `SELECT * FROM ${bobDocId};`
    );
    expect((leaked[0].result as unknown[]).length).toBe(1);

    // Source guard: the per-request query path in `documents.local.ts` selects a
    // Bearer (record-access) session and never reads the root credentials.
    // Switching the impl's query cred to root would make the isolation assertion
    // above leak. Asserted over comment-stripped code so a stray comment can
    // neither satisfy the Bearer check nor smuggle a root-cred read past it.
    const localSource = stripJsComments(
      readFileSync(join(REPO_DATA_SRC, "documents.local.ts"), "utf8")
    );
    expect(BEARER_AUTH_RE.test(localSource)).toBe(true);
    expect(readsRootCredential(localSource)).toBe(false);
  } finally {
    sidecar.stop();
  }
});
