// Acceptance — the server-assigned monotonic cursor via SurrealDB DEFINE
// SEQUENCE.
//
// The cursor is minted ONLY from a DEFINE SEQUENCE (one sequence per
// (collection, scope)) advanced through the `sequence::` function namespace —
// NEVER a MAX(cursor)+1 read-then-write, which reproduces the concurrency race
// the design exists to prevent. Asserts: successive advances are strictly
// increasing; two concurrent writers receive distinct, strictly-increasing
// cursors with no duplicate or reused value; separate (collection, scope)
// sequences advance independently.
//
// Drives a real loopback `surreal` 3.1.5 sidecar; the sql client is imported
// DYNAMICALLY inside the test bodies.
//
// The cursor is advanced via `sequence::nextval(<name>)`, confirmed against the
// v3.1.5 pin; these tests drive the real sequence end to end.

import { type ChildProcess, spawn } from "node:child_process";
import { expect, test } from "vitest";

const LOOPBACK = "127.0.0.1";
const ROOT_USER = "root";
const ROOT_PASS = "root_secret_for_test_only";
const SIDECAR_PORT = 18_042;
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;
const SURREAL_NS = "perry";
const SURREAL_DB = "perry";
const CONCURRENT_WRITERS = 16;

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

// One sequence per (collection, scope). The name encodes both so two scopes
// never share a counter.
const SEQ = "seq_documents_userA";

const defineSequence = (name: string): string =>
  `DEFINE SEQUENCE ${name} BATCH 1000 START 1;`;

const nextval = (name: string): string =>
  `RETURN sequence::nextval("${name}");`;

test("successive advances of the sequence are strictly increasing", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, defineSequence(SEQ));

    const first = await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      ROOT,
      nextval(SEQ)
    );
    const second = await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      ROOT,
      nextval(SEQ)
    );
    const a = first[0]?.result as number;
    const b = second[0]?.result as number;
    expect(typeof a).toBe("number");
    expect(b).toBeGreaterThan(a);
  } finally {
    sidecar.stop();
  }
});

test("two concurrent writers receive distinct, strictly-increasing cursors with no duplicate or reused value", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, defineSequence(SEQ));

    // Fire many advances concurrently — the exact race a MAX(cursor)+1
    // read-then-write would lose. DEFINE SEQUENCE serializes the counter.
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_WRITERS }, () =>
        sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, nextval(SEQ))
      )
    );
    const cursors = results.map((r) => r[0]?.result as number);

    // No duplicate / reused value.
    expect(new Set(cursors).size).toBe(CONCURRENT_WRITERS);
    // The full set is exactly a contiguous strictly-increasing run (no gaps,
    // no reuse), proving monotonic minting under concurrency.
    const sorted = [...cursors].sort((x, y) => x - y);
    const min = sorted[0] as number;
    expect(sorted).toEqual(
      Array.from({ length: CONCURRENT_WRITERS }, (_, i) => min + i)
    );
  } finally {
    sidecar.stop();
  }
});

test("separate (collection, scope) sequences advance independently", async () => {
  const sidecar = await startMemorySidecar();
  try {
    const sql = await loadSql();
    const seqA = "seq_documents_userA";
    const seqB = "seq_documents_userB";
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, defineSequence(seqA));
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, defineSequence(seqB));

    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, nextval(seqA));
    await sql(sidecar.url, SURREAL_NS, SURREAL_DB, ROOT, nextval(seqA));
    const bFirst = await sql(
      sidecar.url,
      SURREAL_NS,
      SURREAL_DB,
      ROOT,
      nextval(seqB)
    );
    // B's counter is independent of A's — its first value starts at the
    // sequence START, not continued from A.
    expect(bFirst[0]?.result).toBe(1);
  } finally {
    sidecar.stop();
  }
});
