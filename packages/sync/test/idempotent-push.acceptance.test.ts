// Acceptance — idempotent batched push returning the per-id server cursor.
//
// Asserts the push behavior the sync flow depends on: one batched op dedups by
// the client-minted ULID id, mints a server-assigned cursor per newly-accepted
// delta, and returns the cursor PER accepted id; a replay of an already-ingested
// batch is a no-op (no duplicate row, no error) that returns the SAME per-id
// cursors; a re-push after a partial prior attempt converges to one row set and
// the same cursors; and a second batch of new deltas continues the
// (collection,scope) cursor sequence (cursors strictly past the prior max).
//
// Drives a real loopback `surreal` 3.1.5 sidecar. The push surface is imported
// statically (an inert, payload-opaque stub); the sql client is imported
// DYNAMICALLY inside the test bodies, so the not-yet-final transport is never
// resolved at collection time.
//
// RED PHASE: every test is skipped until the forwarder push + the green-phase
// schema additions (ULID UNIQUE dedup, the cursor sequence) land. These scaffolds
// assert the BEHAVIOR, not a fixed query string.

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { pushDeltaBatch } from "../src/push";

const LOOPBACK = "127.0.0.1";
const ROOT_USER = "root";
const ROOT_PASS = "root_secret_for_test_only";
const SIDECAR_PORT = 18_043;
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;
const SURREAL_NS = "perry";
const SURREAL_DB = "perry";
const COLLECTION = "documents";
// base64 of "hello" — an opaque, transport-only update payload.
const PAYLOAD_B64 = "aGVsbG8=";
const BATCH_SIZE = 3;

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

// Crockford base32 — the ULID alphabet. A client-minted, 26-char ULID is the
// idempotent dedup key; the time head is restricted to 0-7 so it parses as a ULID.
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

// The opaque forwarder transport, backed by the sidecar sql client under the
// deploy/root cred. The push carries the base64 payload through it verbatim.
const transportFor = (sql: SqlFn, url: string) => ({
  run: (query: string, vars?: Record<string, string>) =>
    sql(url, SURREAL_NS, SURREAL_DB, ROOT, query, vars),
});

const makeDelta = (docId: string, scope: string) => ({
  id: mintUlid(),
  scope_user_id: scope,
  doc_id: docId,
  doc_schema_version: 1,
  payload: PAYLOAD_B64,
});

const rowCount = async (
  sql: SqlFn,
  url: string,
  where: string
): Promise<number> => {
  const rows = await sql(
    url,
    SURREAL_NS,
    SURREAL_DB,
    ROOT,
    `SELECT count() FROM document_delta WHERE ${where} GROUP ALL;`
  );
  const grouped = rows[0]?.result as { count: number }[] | undefined;
  return grouped?.[0]?.count ?? 0;
};

test("a batched push assigns a server cursor to each accepted delta id", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, schemaText());
    const scope = mintUlid();
    const deltas = Array.from({ length: BATCH_SIZE }, () =>
      makeDelta(mintUlid(), scope)
    );

    const result = await pushDeltaBatch(deltas, {
      transport: transportFor(sql, sidecar.url),
      flushVerdict: "flush",
      collection: COLLECTION,
    });

    // One ack per delta id, every cursor a distinct positive integer.
    expect(result.acks).toHaveLength(BATCH_SIZE);
    const ackedIds = new Set(result.acks.map((a) => a.id));
    expect(ackedIds).toEqual(new Set(deltas.map((d) => d.id)));
    const cursors = result.acks.map((a) => a.cursor);
    for (const cursor of cursors) {
      expect(Number.isInteger(cursor)).toBe(true);
      expect(cursor).toBeGreaterThan(0);
    }
    expect(new Set(cursors).size).toBe(BATCH_SIZE);
  } finally {
    sidecar.stop();
  }
});

test("replaying an already-ingested batch is a no-op — no duplicate rows, no error, same per-id cursors", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, schemaText());
    const transport = transportFor(sql, sidecar.url);
    const scope = mintUlid();
    const deltas = Array.from({ length: BATCH_SIZE }, () =>
      makeDelta(mintUlid(), scope)
    );

    const first = await pushDeltaBatch(deltas, {
      transport,
      flushVerdict: "flush",
      collection: COLLECTION,
    });
    // The identical batch, replayed: no error, no second row, same cursors.
    const replay = await pushDeltaBatch(deltas, {
      transport,
      flushVerdict: "flush",
      collection: COLLECTION,
    });

    const cursorById = (r: typeof first) =>
      Object.fromEntries(r.acks.map((a) => [a.id, a.cursor]));
    expect(cursorById(replay)).toEqual(cursorById(first));
    expect(await rowCount(sql, sidecar.url, `scope_user_id = '${scope}'`)).toBe(
      BATCH_SIZE
    );
  } finally {
    sidecar.stop();
  }
});

test("a replay after a partial prior attempt converges to one row set and the same cursors", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, schemaText());
    const transport = transportFor(sql, sidecar.url);
    const scope = mintUlid();
    const docId = mintUlid();
    const deltas = Array.from({ length: BATCH_SIZE }, () =>
      makeDelta(docId, scope)
    );

    // A partial prior attempt ingested only the first delta.
    const partial = await pushDeltaBatch([deltas[0]], {
      transport,
      flushVerdict: "flush",
      collection: COLLECTION,
    });
    const firstCursor = partial.acks[0]?.cursor;

    // The retry pushes the WHOLE batch including the already-ingested id.
    const full = await pushDeltaBatch(deltas, {
      transport,
      flushVerdict: "flush",
      collection: COLLECTION,
    });

    // The already-ingested id keeps its original cursor (no re-mint); the batch
    // converges to exactly one row per id.
    const fullById = Object.fromEntries(full.acks.map((a) => [a.id, a.cursor]));
    expect(fullById[deltas[0].id]).toBe(firstCursor);
    expect(await rowCount(sql, sidecar.url, `doc_id = '${docId}'`)).toBe(
      BATCH_SIZE
    );
  } finally {
    sidecar.stop();
  }
});

test("a second batch of new deltas continues the (collection,scope) cursor sequence", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, schemaText());
    const transport = transportFor(sql, sidecar.url);
    const scope = mintUlid();

    const batchA = await pushDeltaBatch(
      Array.from({ length: BATCH_SIZE }, () => makeDelta(mintUlid(), scope)),
      { transport, flushVerdict: "flush", collection: COLLECTION }
    );
    const batchB = await pushDeltaBatch(
      Array.from({ length: BATCH_SIZE }, () => makeDelta(mintUlid(), scope)),
      { transport, flushVerdict: "flush", collection: COLLECTION }
    );

    const maxA = Math.max(...batchA.acks.map((a) => a.cursor));
    const minB = Math.min(...batchB.acks.map((a) => a.cursor));
    // The sequence is monotonic across pushes — B starts strictly past A's max.
    expect(minB).toBeGreaterThan(maxA);
  } finally {
    sidecar.stop();
  }
});
