// Acceptance tests for the local store HTTP wire + CRUD round-trip.
//
// Verify HTTP-only access via native fetch with CRUD round-tripping the
// canonical Zod shapes, response bodies consumed via getReader (never
// feature-detected), and the HTTP contract where a 200 with a per-statement
// error makes the client throw. The store impl and `@perry-starter/db`
// artefacts are imported DYNAMICALLY inside the test bodies. A real loopback
// `surreal` sidecar is spawned per test and torn down afterward.

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// --- Test-only loopback `surreal` sidecar (in-memory backend) ---

const LOOPBACK = "127.0.0.1";
const ROOT_USER = "root";
const ROOT_PASS = "root_secret_for_test_only";
const SIDECAR_PORT = 18_037;
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;
const SURREAL_NS = "perry";
const SURREAL_DB = "perry";
const INTEGER_FIXTURE = 42; // integers round-trip as integers, not strings

// getReader-discipline matchers (top-level: Biome useTopLevelRegex).
const READ_CALL_RE = /\.read\(\)/;
const GETREADER_TYPEOF_RE = /typeof[^;\n]*getReader/;
const GETREADER_IN_RE = /["']getReader["']\s+in\b/;
const GETREADER_OPTIONAL_RE = /getReader\?\./;

interface Sidecar {
  readonly stop: () => void;
  readonly url: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// Spawns a hardened, loopback, in-memory `surreal` (deny guests/scripting/net;
// `--bind` defaults to loopback). Waits on `/health`, returns a stop handle.
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

// Function-indirected dynamic import: keeps the specifier non-statically-
// analyzable so Vite/esbuild never tries to resolve the not-yet-existing
// modules at collection time.
const dyn = (specifier: string): Promise<Record<string, unknown>> =>
  import(specifier) as Promise<Record<string, unknown>>;

const REPO_DATA_SRC = join(process.cwd(), "packages", "data", "src");
const SDK_SPECIFIERS = ["surrealdb", "surrealdb.js", "@surrealdb/wasm"];
const IMPORT_RE = /(?:import|require)\s*\(?\s*["']([^"']+)["']/g;

test("documents access is HTTP-only via native fetch — no SurrealDB SDK or WASM import in the local store graph", () => {
  // The local store graph must reach SurrealDB over loopback HTTP only. The JS
  // SDK and WASM bundles are excluded, so neither may be imported here.
  const localFiles = [
    join(REPO_DATA_SRC, "surreal-http.ts"),
    join(REPO_DATA_SRC, "documents.local.ts"),
  ];
  for (const file of localFiles) {
    const source = readFileSync(file, "utf8");
    const specifiers = [...source.matchAll(IMPORT_RE)].map((m) => m[1]);
    for (const forbidden of SDK_SPECIFIERS) {
      // A file that imports `surrealdb` into the local graph would fail this.
      expect(specifiers).not.toContain(forbidden);
    }
  }
});

test("documents CRUD round-trips the canonical Zod shape over a real loopback sidecar", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const httpMod = await dyn("@perry-starter/data/surreal-http");
    const dataMod = await dyn("@perry-starter/data/documents.local");
    const dbMod = await dyn("@perry-starter/db");

    const applySchema = httpMod.sql as (
      url: string,
      ns: string,
      db: string,
      auth: { kind: "basic"; user: string; pass: string },
      query: string
    ) => Promise<unknown>;
    const documentSchema = dbMod.documentSchema as {
      parse: (value: unknown) => unknown;
    };
    const makeStore = dataMod.createDocumentsLocal as (cfg: {
      url: string;
      ns: string;
      db: string;
    }) => {
      create: (input: unknown) => Promise<unknown>;
      read: (id: string) => Promise<unknown>;
      update: (id: string, patch: unknown) => Promise<unknown>;
      delete: (id: string) => Promise<void>;
    };

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
    await applySchema(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      { kind: "basic", user: ROOT_USER, pass: ROOT_PASS },
      schemaText
    );

    const store = makeStore({
      url: sidecar.url,
      ns: SURREAL_NS,
      db: SURREAL_DB,
    });

    // Create → read → update → delete, each output `.parse()`d against the
    // single-sourced canonical Zod shape. An impl that drops a required field
    // or returns an in-memory stub (no HTTP round-trip) makes `.parse()` throw
    // or the read-after-write fail.
    const created = documentSchema.parse(
      await store.create({ title: "hello" })
    );
    const createdId = (created as { id: string }).id;

    const read = documentSchema.parse(await store.read(createdId));
    expect((read as { title: string }).title).toBe("hello");

    const updated = documentSchema.parse(
      await store.update(createdId, { title: "hello, world" })
    );
    expect((updated as { title: string }).title).toBe("hello, world");

    await store.delete(createdId);
    await expect(store.read(createdId)).rejects.toThrow();
  } finally {
    sidecar.stop();
  }
});

test("response bodies are consumed via res.body.getReader() + read(), never feature-detected", () => {
  // Under the daemon's fetch, `typeof res.body.getReader` reports `undefined`
  // even though the method works. Feature-detecting it silently disables
  // streaming, so the helper must call `getReader()`/`read()` with no detection.
  const source = readFileSync(join(REPO_DATA_SRC, "surreal-http.ts"), "utf8");

  expect(source).toContain("getReader()");
  expect(source).toMatch(READ_CALL_RE);

  // Any feature-detect (`typeof … getReader`, `"getReader" in …`,
  // `getReader?.`) would trip this guard.
  expect(source).not.toMatch(GETREADER_TYPEOF_RE);
  expect(source).not.toMatch(GETREADER_IN_RE);
  expect(source).not.toMatch(GETREADER_OPTIONAL_RE);
});

test("HTTP 200 with a per-statement status of ERR makes the client throw", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const httpMod = await dyn("@perry-starter/data/surreal-http");
    const sql = httpMod.sql as (
      url: string,
      ns: string,
      db: string,
      auth: { kind: "basic"; user: string; pass: string },
      query: string
    ) => Promise<Array<{ status: "OK" | "ERR"; result: unknown }>>;
    const basic = { kind: "basic", user: ROOT_USER, pass: ROOT_PASS } as const;

    // HTTP 200 ≠ success: a statement against an undefined namespace returns
    // 200 with body[0].status === "ERR". The client must throw. A client that
    // treats HTTP 200 as success would swallow the ERR row.
    await expect(
      sql(
        sidecar.url,
        "no_such_ns",
        "no_such_db",
        basic,
        "SELECT * FROM documents;"
      )
    ).rejects.toThrow();

    // Integer round-trip: `n=42` returns the integer 42 (not a string).
    const rows = await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      basic,
      `RETURN ${INTEGER_FIXTURE};`
    );
    expect(rows[0].status).toBe("OK");
    expect(rows[0].result).toBe(INTEGER_FIXTURE);
  } finally {
    sidecar.stop();
  }
});

test.skip("surrealkv on-disk durability survives a restart — operator drill, not run in CI", async () => {
  // Durable on-disk persistence is not yet validated end to end; CI runs the
  // in-memory backend only. This is an operator restart-and-reread drill, never
  // wired into CI. When run, if surrealkv does not persist, the reread after
  // the restart returns nothing.
  const dataDir = join(process.cwd(), ".surreal-durability-drill-1-3");
  const httpMod = await dyn("@perry-starter/data/surreal-http");
  const sql = httpMod.sql as (
    url: string,
    ns: string,
    db: string,
    auth: { kind: "basic"; user: string; pass: string },
    query: string
  ) => Promise<Array<{ status: "OK" | "ERR"; result: unknown }>>;
  const basic = { kind: "basic", user: ROOT_USER, pass: ROOT_PASS } as const;
  const url = `http://${LOOPBACK}:${SIDECAR_PORT}`;

  const spawnPersistent = (): ChildProcess =>
    spawn(
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
        `surrealkv://${dataDir}`,
      ],
      { stdio: "ignore" }
    );

  const first = spawnPersistent();
  await sleep(HEALTH_POLL_MS * HEALTH_MAX_ATTEMPTS);
  await sql(
    url,
    SURREAL_NS,
    SURREAL_DB,
    basic,
    "CREATE documents:durable SET title = 'survives';"
  );
  first.kill();
  await sleep(HEALTH_POLL_MS);

  const second = spawnPersistent();
  await sleep(HEALTH_POLL_MS * HEALTH_MAX_ATTEMPTS);
  const rows = await sql(
    url,
    SURREAL_NS,
    SURREAL_DB,
    basic,
    "SELECT title FROM documents:durable;"
  );
  second.kill();

  expect(rows[0].status).toBe("OK");
  expect(rows[0].result).toMatchObject([{ title: "survives" }]);
});
