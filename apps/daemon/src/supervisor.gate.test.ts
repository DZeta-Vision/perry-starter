// The supervisor spawns a hardened, loopback `surreal` sidecar with an assigned
// loopback port + a per-app data-dir, polls `/health` to readiness, re-spawns on
// an unexpected exit, and prints the bound `http://127.0.0.1:<port>` URL on
// start. Driven against a real in-memory `surreal` sidecar. Paired twin:
// supervisor.mutation.test.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const LOOPBACK_URL_RE = /http:\/\/127\.0\.0\.1:(\d+)/;
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;

interface SupervisorHandle {
  readonly dataDir: string;
  // Forces the underlying sidecar to exit, to exercise the restart policy.
  readonly killSidecarForTest: () => void;
  readonly port: number;
  readonly stop: () => Promise<void>;
  readonly url: string;
}

const dyn = (specifier: string): Promise<Record<string, unknown>> =>
  import(specifier) as Promise<Record<string, unknown>>;

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });

const healthIsUp = async (url: string): Promise<boolean> => {
  try {
    const res = await fetch(`${url}/health`);
    return res.ok;
  } catch {
    return false;
  }
};

const waitForHealth = async (url: string): Promise<boolean> => {
  for (let attempt = 0; attempt < HEALTH_MAX_ATTEMPTS; attempt += 1) {
    if (await healthIsUp(url)) {
      return true;
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
};

const startSupervisor = async (opts: {
  dataDir: string;
  print: (line: string) => void;
}): Promise<SupervisorHandle> => {
  const mod = await dyn("./supervisor");
  const start = mod.startSupervisor as (o: {
    backend: "memory";
    dataDir: string;
    print: (line: string) => void;
  }) => Promise<SupervisorHandle>;
  return start({ backend: "memory", dataDir: opts.dataDir, print: opts.print });
};

describe("the supervisor assigns a loopback port + per-app data-dir, reaches health, restarts on exit, and prints the URL", () => {
  test("it assigns a loopback port + the per-app data-dir and reaches /health readiness", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "perry-appdata-"));
    const lines: string[] = [];
    const sup = await startSupervisor({ dataDir, print: (l) => lines.push(l) });
    try {
      expect(sup.url).toMatch(LOOPBACK_URL_RE);
      expect(sup.port).toBeGreaterThan(0);
      expect(sup.dataDir).toBe(dataDir);
      expect(await waitForHealth(sup.url)).toBe(true);
    } finally {
      await sup.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("on a forced sidecar exit it re-spawns per the restart policy and /health recovers", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "perry-appdata-"));
    const sup = await startSupervisor({ dataDir, print: () => undefined });
    try {
      expect(await waitForHealth(sup.url)).toBe(true);
      sup.killSidecarForTest();
      await sleep(HEALTH_POLL_MS);
      // The restart policy must re-spawn the sidecar so health comes back.
      expect(await waitForHealth(sup.url)).toBe(true);
    } finally {
      await sup.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("on start it prints the bound loopback URL matching the assigned port", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "perry-appdata-"));
    const lines: string[] = [];
    const sup = await startSupervisor({ dataDir, print: (l) => lines.push(l) });
    try {
      const printed = lines.find((l) => LOOPBACK_URL_RE.test(l));
      expect(printed).toBeDefined();
      const match = LOOPBACK_URL_RE.exec(printed ?? "");
      expect(match?.[1]).toBe(String(sup.port));
    } finally {
      await sup.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
