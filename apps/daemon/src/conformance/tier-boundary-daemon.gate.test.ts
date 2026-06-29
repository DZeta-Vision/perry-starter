import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Conformance gate — the tier-boundary build guard rejects any transitive
// in-process WASM/prebuilt-JS/cloud import into the daemon graph.
// `scripts/tier-boundary-guard.mjs` lists `apps/daemon` among its daemon-graph
// roots; this is the daemon-graph anti-vacuous proof:
//   - the guard exits 0 on the clean daemon graph (`--root`);
//   - a denylisted specifier planted in an apps/daemon fixture under
//     `__fixtures__/` makes the guard exit non-zero (`--scan`).
//
// The guard stays non-blocking (STRUCTURE) as the build-seam guard was wired;
// this only adds the daemon-graph proof and does NOT promote it to blocking. The
// fixture `apps/daemon/src/__fixtures__/denylisted-dep-into-daemon.ts` carries
// the planted violation.

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/daemon/src/conformance
// apps/daemon/src/conformance → repo root is four levels up.
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const GUARD = resolve(REPO_ROOT, "scripts", "tier-boundary-guard.mjs");
const DAEMON_DENYLIST_FIXTURE = resolve(
  REPO_ROOT,
  "apps/daemon/src/__fixtures__/denylisted-dep-into-daemon.ts"
);

// Run the guard and return its process exit code (0 clean, non-zero on a flagged
// violation). execFileSync throws with a numeric `status` on non-zero.
const runGuard = (args: string[]): number => {
  try {
    execFileSync(process.execPath, [GUARD, ...args], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    return 0;
  } catch (error) {
    const status = (error as { status?: number }).status;
    return typeof status === "number" ? status : 1;
  }
};

describe("the tier-boundary guard proves the daemon graph stays free of WASM/prebuilt-JS/cloud imports", () => {
  test("the guard exits 0 on the clean daemon graph (--root)", () => {
    expect(runGuard(["--root", REPO_ROOT])).toBe(0);
  });

  test("the guard exits non-zero on a planted denylisted dep in an apps/daemon fixture (--scan)", () => {
    expect(runGuard(["--scan", DAEMON_DENYLIST_FIXTURE])).not.toBe(0);
  });
});
