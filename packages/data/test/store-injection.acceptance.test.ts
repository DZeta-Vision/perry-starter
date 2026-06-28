// Acceptance tests for parameterized-queries-only discipline.
//
// Verify that every query site passes values as bind variables with zero
// SurrealQL string interpolation, including the negative: a `'; DELETE …`
// payload bound as a $var must not escape the query or mutate the store. The
// impl and schema are imported/read dynamically inside the test bodies.

import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const LOOPBACK = "127.0.0.1";
const ROOT_USER = "root";
const ROOT_PASS = "root_secret_for_test_only";
const SIDECAR_PORT = 18_041;
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;
const SURREAL_NS = "perry";
const SURREAL_DB = "perry";
const REPO_DATA_SRC = join(process.cwd(), "packages", "data", "src");
const SEED_DOC_COUNT = 3;

// A statement-terminating injection probe. If a value is interpolated into the
// SurrealQL body rather than bound as a $var, the `DELETE` runs.
const INJECTION_PAYLOAD = "x'; DELETE documents; --";

// Top-level regex literals (Biome: never build regex inside loops).
// A SurrealQL body literal (`/sql` fetch body or `sql(` arg) that embeds a
// template-literal interpolation `${…}` is the forbidden injection surface.
const SQL_TEMPLATE_INTERP_RE =
  /(?:SELECT|CREATE|UPDATE|DELETE|RELATE|INSERT|UPSERT)\b[^`]*\$\{/i;

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

test("all values are parameterized via $vars / type:: constructors — zero SurrealQL string interpolation", () => {
  // Static source scan of every query site in the local store graph. A query
  // like `SELECT * FROM documents WHERE id = ${userInput}` (an interpolated
  // value in a SurrealQL body) would trip this guard.
  const files = readdirSync(REPO_DATA_SRC).filter((f) => f.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(0);

  for (const file of files) {
    const source = readFileSync(join(REPO_DATA_SRC, file), "utf8");
    const offending = source
      .split("\n")
      .filter((line) => SQL_TEMPLATE_INTERP_RE.test(line));
    expect(offending).toEqual([]);
  }
});

test("a malicious '; DELETE … payload is bound as a $var and never escapes the query or mutates the store", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const httpMod = await dyn("@perry-starter/data/surreal-http");
    const dataMod = await dyn("@perry-starter/data/documents.local");
    const sql = httpMod.sql as (
      url: string,
      ns: string,
      db: string,
      auth: { kind: "basic"; user: string; pass: string },
      query: string
    ) => Promise<Array<{ status: "OK" | "ERR"; result: unknown }>>;
    const makeStore = dataMod.createDocumentsLocal as (cfg: {
      url: string;
      ns: string;
      db: string;
    }) => {
      create: (input: unknown) => Promise<{ id: string }>;
      read: (id: string) => Promise<{ title: string } | null>;
      list: () => Promise<unknown[]>;
    };

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
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, basic, schemaText);

    const store = makeStore({
      url: sidecar.url,
      ns: SURREAL_NS,
      db: SURREAL_DB,
    });

    // Seed a known number of benign rows.
    for (let i = 0; i < SEED_DOC_COUNT; i += 1) {
      await store.create({ title: `seed-${i}` });
    }

    // Write the injection payload THROUGH the impl as a value. A correct impl
    // binds it as a $var, so the `DELETE` text is stored literally and never
    // executed. An impl that interpolated the value would run the DELETE and
    // the seeded rows would vanish.
    const created = await store.create({ title: INJECTION_PAYLOAD });

    const readBack = await store.read(created.id);
    // The payload round-trips as inert data, character-for-character.
    expect(readBack?.title).toBe(INJECTION_PAYLOAD);

    const survivors = await store.list();
    // SEED_DOC_COUNT benign rows + the one payload row all survive.
    expect(survivors.length).toBe(SEED_DOC_COUNT + 1);
  } finally {
    sidecar.stop();
  }
});
