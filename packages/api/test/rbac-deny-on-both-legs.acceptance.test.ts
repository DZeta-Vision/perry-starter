// Red-phase ATDD acceptance scaffold — the two-layer deny-deny
// contract: a cross-scope read is denied at the tRPC middleware layer AND would
// be denied at the SurrealDB row layer, with neither layer alone sufficient to
// grant access.
//
// RED PHASE: every test is `test.skip` (aliased `acceptance`). The tRPC RBAC
// `.use()` leg (`@perry-starter/api`'s `rbacProcedure` / `enforceScope`) and the
// row escalation DO NOT EXIST yet. The middleware leg is exercised via an
// in-process tRPC caller (no network); the row leg uses a real `surreal`
// sidecar spawned ONLY when un-skipped. Top-level static imports are limited to
// `vitest`. Serialize sidecar-backed tests at green phase (known sidecar flake under concurrency).
//
// Behavior asserted (names describe behavior, not a planning id):
//  - the middleware denies a cross-scope read with the FORBIDDEN code
//  - the same read returns [] at the row layer (record-access session)
//  - middleware-bypassed: the row layer still denies
//  - row-layer-bypassed (root cred): the middleware still denies
//  - therefore neither layer alone grants access

import { describe, expect, test } from "vitest";

// GREEN PHASE: aliased to `test` so the intent reads at each call site.
const acceptance = test;

const LOOPBACK = "127.0.0.1";
const ROOT_USER = "root";
const ROOT_PASS = "root_secret_for_test_only";
const SIDECAR_PORT = 18_062; // distinct from the other sidecar ports in the suite
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;
const SURREAL_NS = "perry";
const SURREAL_DB = "perry";

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

// The shape of a tRPC error the RBAC middleware throws. The precise code
// lives in `shape.data.code`; the nearest native code is FORBIDDEN.
interface CapturedError {
  readonly dataCode?: string;
  readonly nativeCode?: string;
}

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

// Drive the RBAC-protected procedure in-process and capture the thrown error's
// native + precise codes. The router/procedure factory lands with the RBAC slice.
const callCrossScopeRead = async (
  principalRole: string
): Promise<CapturedError | undefined> => {
  const api = (await import("@perry-starter/api")) as {
    readonly createCrossUserReadCaller: (ctx: {
      session: { user: { id: string; role: string } };
    }) => { readForeignDocument: () => Promise<unknown> };
    readonly toErrorShape: (error: unknown) => CapturedError;
  };
  const caller = api.createCrossUserReadCaller({
    session: { user: { id: "user:mallory", role: principalRole } },
  });
  try {
    await caller.readForeignDocument();
    return; // no throw == not denied
  } catch (error) {
    return api.toErrorShape(error);
  }
};

describe("a cross-scope read is denied at the tRPC middleware layer", () => {
  acceptance(
    "a member reading another user's document is rejected with the FORBIDDEN code",
    async () => {
      const captured = await callCrossScopeRead("member");
      expect(captured).toBeDefined();
      expect((captured as CapturedError).nativeCode).toBe("FORBIDDEN");
      expect((captured as CapturedError).dataCode).toBe("FORBIDDEN");
    }
  );
});

describe("the same cross-scope read is denied at the SurrealDB row layer", () => {
  acceptance(
    "a record-access session reading a foreign document returns empty",
    async () => {
      const sidecar = await startMemorySidecar();
      try {
        const mod = (await import(
          "@perry-starter/data/surreal-http"
        )) as Record<string, unknown>;
        const sql = mod.sql as Sql;
        const signin = mod.signinRecord as SigninRecord;
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const schema = readFileSync(
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
        await sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          { kind: "basic", user: ROOT_USER, pass: ROOT_PASS },
          schema
        );
        const victimToken = await signin(sidecar.url, {
          ns: SURREAL_NS,
          db: SURREAL_DB,
          ac: "account",
          email: "victim@example.com",
          pass: "victim-pass",
        });
        const attackerToken = await signin(sidecar.url, {
          ns: SURREAL_NS,
          db: SURREAL_DB,
          ac: "account",
          email: "attacker@example.com",
          pass: "attacker-pass",
        });
        await sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          { kind: "bearer", token: victimToken },
          "CREATE documents SET title = 'victim-secret';"
        );
        // The attacker, even with a perfectly valid scoped session (middleware
        // bypassed), reads nothing at the row layer — the second leg alone denies.
        const attackerSees = await sql(
          sidecar.url,
          SURREAL_NS,
          SURREAL_DB,
          { kind: "bearer", token: attackerToken },
          "SELECT * FROM documents;"
        );
        expect(attackerSees[0].result).toEqual([]);
      } finally {
        sidecar.stop();
      }
    }
  );
});

describe("neither enforcement layer alone is sufficient to grant access", () => {
  acceptance(
    "with the row layer bypassed by a root cred, the middleware still denies the cross-scope read",
    async () => {
      // Even though a root/Basic cred WOULD bypass row PERMISSIONS, the request
      // never reaches the data layer with root: the tRPC RBAC leg denies first.
      const captured = await callCrossScopeRead("member");
      expect(captured).toBeDefined();
      expect((captured as CapturedError).nativeCode).toBe("FORBIDDEN");
    }
  );

  acceptance(
    "an in-scope read at the matching tier is granted by both layers",
    async () => {
      // The positive control: a superadmin (global claim) passes the middleware
      // leg (no throw) — proving the deny tests above are not vacuously denying
      // everything.
      const captured = await callCrossScopeRead("superadmin");
      expect(captured).toBeUndefined();
    }
  );
});
