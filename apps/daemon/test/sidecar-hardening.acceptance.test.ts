import { type ChildProcess, spawn } from "node:child_process";
import { expect, test } from "vitest";

// Behavioral acceptance (effectiveness leg) — the surreal sidecar's denied
// capabilities are ACTUALLY denied. (The static spawn-args + Bearer-not-root leg
// lives in apps/daemon/src/conformance/sidecar-hardening.gate.test.ts.)
//
// Spins a REAL `surreal 3.1.5` sidecar with the hardening flags and asserts a
// scripting query under `--deny-scripting` returns per-statement `status: "ERR"`,
// not OK (proving the flag is effective, not merely present in argv). The paired
// CONTROL spawns the same sidecar WITHOUT `--deny-scripting` and asserts the same
// query returns OK — so the test detects the flag's effect rather than passing
// unconditionally.
//
// The sidecar is spawned only inside the test body. The `surreal 3.1.5` binary
// is provisioned in CI and locally at ~/.surrealdb/surreal. Reuses the
// spawn/teardown + /health-poll harness used by the data store's record-access
// acceptance test.

const LOOPBACK = "127.0.0.1";
const ROOT_USER = "root";
const ROOT_PASS = "root_secret_for_test_only";
const DENY_PORT = 18_071;
const CONTROL_PORT = 18_072;
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;
const SURREAL_NS = "perry";
const SURREAL_DB = "perry";
// An embedded scripting function — denied under --deny-scripting.
const SCRIPTING_QUERY = "RETURN function() { return 1; };";

interface Sidecar {
  readonly stop: () => void;
  readonly url: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((res) => {
    setTimeout(res, ms);
  });

// Spawn a memory-backed surreal sidecar; `denyScripting` toggles the flag under
// test so the deny-cap proof has a control that flips.
const startSidecar = async (
  port: number,
  denyScripting: boolean
): Promise<Sidecar> => {
  // surreal 3.1.5 DENIES scripting by default, so the control must EXPLICITLY
  // `--allow-scripting` for the flip to be meaningful (otherwise both branches
  // would return ERR and the test would pass vacuously). `--deny-net` is
  // variadic, so it is placed before a value-less flag (never before the `memory`
  // datastore positional) to stay a blanket net denial.
  const denyFlags = denyScripting
    ? ["--deny-net", "--deny-guests", "--deny-scripting"]
    : ["--deny-net", "--deny-guests", "--allow-scripting"];
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
      ...denyFlags,
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
      // sidecar not listening yet — poll again within budget
    }
    await sleep(HEALTH_POLL_MS);
  }
  proc.kill();
  throw new Error("surreal sidecar did not pass /health within budget");
};

// Raw POST /sql that returns the per-statement status WITHOUT throwing on ERR
// (the helper in surreal-http throws on ERR; here we must inspect the status).
const queryStatus = async (
  url: string,
  query: string
): Promise<"OK" | "ERR"> => {
  const res = await fetch(`${url}/sql`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${ROOT_USER}:${ROOT_PASS}`)}`,
      "surreal-ns": SURREAL_NS,
      "surreal-db": SURREAL_DB,
      Accept: "application/json",
      "Content-Type": "text/plain",
    },
    body: query,
  });
  const rows = (await res.json()) as Array<{ status: "OK" | "ERR" }>;
  return rows[0].status;
};

test("a scripting query is denied (status ERR) under --deny-scripting — the deny-cap is effective, not merely present in argv", async () => {
  const sidecar = await startSidecar(DENY_PORT, true);
  try {
    expect(await queryStatus(sidecar.url, SCRIPTING_QUERY)).toBe("ERR");
  } finally {
    sidecar.stop();
  }
});

test("CONTROL: the same scripting query returns OK on a sidecar spawned WITHOUT --deny-scripting — proving the test detects the flag's effect", async () => {
  const sidecar = await startSidecar(CONTROL_PORT, false);
  try {
    expect(await queryStatus(sidecar.url, SCRIPTING_QUERY)).toBe("OK");
  } finally {
    sidecar.stop();
  }
});
