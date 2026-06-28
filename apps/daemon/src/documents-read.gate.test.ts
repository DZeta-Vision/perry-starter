// The daemon exposes one minimal native read route that lifts the data seam's
// local implementation over the in-memory `surreal` sidecar and returns
// canonical, Zod-parsed rows — proving the shell reads the documents store
// through the seam, not a hard-coded stub.
//
// Driven against a real in-memory `surreal` sidecar + fastify `inject()`. The
// row is seeded THROUGH the seam under a scoped record-access session (the
// table is owner-scoped, so a root insert cannot set the owner field), then read
// back through the route under that same session.

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const LOOPBACK = "127.0.0.1";
const ROOT_USER = "root";
const ROOT_PASS = "root_secret_for_test_only";
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;
const SURREAL_NS = "perry";
const SURREAL_DB = "perry";

// Acquire a free ephemeral loopback port so concurrent sidecar-backed tests
// never collide on a fixed port.
const findFreePort = (): Promise<number> =>
  new Promise<number>((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, LOOPBACK, () => {
      const address = probe.address();
      if (address && typeof address === "object") {
        const { port } = address;
        probe.close(() => resolvePort(port));
      } else {
        probe.close();
        rejectPort(new Error("could not acquire a loopback port"));
      }
    });
  });

interface InjectResponse {
  readonly payload: string;
  readonly statusCode: number;
}

interface DaemonApp {
  readonly inject: (opts: {
    method: string;
    url: string;
  }) => Promise<InjectResponse>;
}

interface SeamSession {
  readonly email: string;
  readonly pass: string;
}

interface DocumentsSeam {
  readonly create: (input: { title: string }) => Promise<unknown>;
  readonly list: () => Promise<unknown>;
}

const dyn = (specifier: string): Promise<Record<string, unknown>> =>
  import(specifier) as Promise<Record<string, unknown>>;

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });

const startMemorySidecar = async (): Promise<{
  stop: () => void;
  url: string;
}> => {
  const port = await findFreePort();
  const proc: ChildProcess = spawn(
    "surreal",
    [
      "start",
      "--bind",
      `${LOOPBACK}:${port}`,
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
  const url = `http://${LOOPBACK}:${port}`;
  for (let attempt = 0; attempt < HEALTH_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        return { url, stop: () => proc.kill() };
      }
    } catch {
      // not listening yet — keep polling within budget
    }
    await sleep(HEALTH_POLL_MS);
  }
  proc.kill();
  throw new Error("surreal sidecar did not pass /health within budget");
};

describe("the daemon read route round-trips the documents store through the local seam", () => {
  test("GET /api/documents returns rows that .parse() against the canonical documents Zod shape", async () => {
    const sidecar = await startMemorySidecar();
    try {
      const httpMod = await dyn("@perry-starter/data/surreal-http");
      const dataMod = await dyn("@perry-starter/data");
      const dbMod = await dyn("@perry-starter/db");
      const readMod = await dyn("./documents-read");

      const sql = httpMod.sql as (
        url: string,
        ns: string,
        db: string,
        auth: { kind: "basic"; pass: string; user: string },
        query: string
      ) => Promise<unknown>;
      const createDocumentsLocal = dataMod.createDocumentsLocal as (cfg: {
        db: string;
        ns: string;
        session?: SeamSession;
        url: string;
      }) => DocumentsSeam;
      const documentSchema = dbMod.documentSchema as {
        parse: (value: unknown) => unknown;
      };
      const createDocumentsReadApp = readMod.createDocumentsReadApp as (deps: {
        db: string;
        ns: string;
        session?: SeamSession;
        url: string;
      }) => DaemonApp;

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
      const basic = {
        kind: "basic",
        user: ROOT_USER,
        pass: ROOT_PASS,
      } as const;
      // Apply the schema (DDL) under the bootstrap root credential.
      await sql(sidecar.url, SURREAL_NS, SURREAL_DB, basic, schemaText);

      // Seed a row THROUGH the seam under a scoped record-access session, so the
      // owner-scoped table accepts it and the same session can read it back.
      const session: SeamSession = {
        email: "seam-read@perry.local",
        pass: "seam_read_pw_123456",
      };
      const seed = createDocumentsLocal({
        url: sidecar.url,
        ns: SURREAL_NS,
        db: SURREAL_DB,
        session,
      });
      await seed.create({ title: "seam-read" });

      const app = createDocumentsReadApp({
        url: sidecar.url,
        ns: SURREAL_NS,
        db: SURREAL_DB,
        session,
      });
      const res = await app.inject({ method: "GET", url: "/api/documents" });
      expect(res.statusCode).toBe(200);

      const rows = JSON.parse(res.payload) as unknown[];
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      // Anti-vacuous: every row must satisfy the single-sourced canonical shape.
      for (const row of rows) {
        documentSchema.parse(row);
      }
    } finally {
      sidecar.stop();
    }
  });
});
