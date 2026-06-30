// Acceptance — the bounded push batch rejects an over-limit batch WHOLE.
//
// A single push carries at most MAX_PUSH_BATCH deltas. An over-limit batch is
// rejected WHOLE — it raises BatchTooLargeError and ingests ZERO rows, so the
// log is never left in an ambiguous partial state (idempotent re-push backstops
// recovery). A batch exactly at the bound is accepted and every id is acked.
//
// Drives a real loopback `surreal` 3.1.5 sidecar so the "no partial ingestion"
// claim is proven against the actual row count, not asserted. The push surface
// is imported statically (an inert stub); the sql client DYNAMICALLY inside the
// test bodies.
//
// RED PHASE: every test is skipped until the forwarder push + green-phase schema
// additions land. The bound VALUE is an assumption; the reject-whole BEHAVIOR is
// value-independent.

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  BatchTooLargeError,
  MAX_PUSH_BATCH,
  pushDeltaBatch,
} from "../src/push";

const LOOPBACK = "127.0.0.1";
const ROOT_USER = "root";
const ROOT_PASS = "root_secret_for_test_only";
const SIDECAR_PORT = 18_045;
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;
const SURREAL_NS = "perry";
const SURREAL_DB = "perry";
const COLLECTION = "documents";
const PAYLOAD_B64 = "aGVsbG8=";

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

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_HEAD = "01234567";
const ULID_TAIL = 25;

const mintUlid = (): string => {
  const bytes = new Uint8Array(ULID_TAIL);
  crypto.getRandomValues(bytes);
  const first = bytes[0] ?? 0;
  let out = TIME_HEAD.charAt(first % TIME_HEAD.length);
  for (const byte of bytes) {
    out += ENCODING.charAt(byte % ENCODING.length);
  }
  return out;
};

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

const makeBatch = (size: number, scope: string) =>
  Array.from({ length: size }, () => ({
    id: mintUlid(),
    scope_user_id: scope,
    doc_id: mintUlid(),
    doc_schema_version: 1,
    payload: PAYLOAD_B64,
  }));

const scopeRowCount = async (
  sql: SqlFn,
  url: string,
  scope: string
): Promise<number> => {
  const rows = await sql(
    url,
    SURREAL_NS,
    SURREAL_DB,
    ROOT,
    `SELECT count() FROM document_delta WHERE scope_user_id = '${scope}' GROUP ALL;`
  );
  const grouped = rows[0]?.result as { count: number }[] | undefined;
  return grouped?.[0]?.count ?? 0;
};

test("an over-limit batch is rejected whole and ingests zero rows (no partial ambiguous ingestion)", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, schemaText());
    const scope = mintUlid();
    const overLimit = makeBatch(MAX_PUSH_BATCH + 1, scope);

    await expect(
      pushDeltaBatch(overLimit, {
        transport: transportFor(sql, sidecar.url),
        flushVerdict: "flush",
        enforcedScopeUserId: scope,
        collection: COLLECTION,
      })
    ).rejects.toThrow(BatchTooLargeError);

    // The whole batch is rejected — not one row reached the log.
    expect(await scopeRowCount(sql, sidecar.url, scope)).toBe(0);
  } finally {
    sidecar.stop();
  }
});

test("a batch exactly at the bounded limit is accepted and every id is acked", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, schemaText());
    const scope = mintUlid();
    const atLimit = makeBatch(MAX_PUSH_BATCH, scope);

    const result = await pushDeltaBatch(atLimit, {
      transport: transportFor(sql, sidecar.url),
      flushVerdict: "flush",
      enforcedScopeUserId: scope,
      collection: COLLECTION,
    });

    expect(result.acks).toHaveLength(MAX_PUSH_BATCH);
    expect(await scopeRowCount(sql, sidecar.url, scope)).toBe(MAX_PUSH_BATCH);
  } finally {
    sidecar.stop();
  }
});
