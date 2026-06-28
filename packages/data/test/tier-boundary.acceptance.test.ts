import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// The tier-boundary build guard (scripts/tier-boundary-guard.mjs) is wired to
// fail on BOTH bundles — a concrete *.cloud.ts/*.local.ts imported into apps/web
// (concrete-impl-into-UI), and a denylisted cloud/WASM/prebuilt-JS specifier
// reachable in the daemon/seam graph. The guard is STRUCTURE (non-blocking);
// blocking enforcement + the full resolved-closure scan + the compile-and-run
// leg are deferred to later hardening. This proves the guard's self-test is
// NON-VACUOUS: clean repo → exit 0, each bad fixture → exit non-zero.
//
// The guard + fixtures are invoked only via execFileSync inside the test
// bodies, so this file collects cleanly.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const GUARD = resolve(REPO_ROOT, "scripts", "tier-boundary-guard.mjs");

const LEAK_CLOUD_INTO_UI = resolve(
  REPO_ROOT,
  "packages/data/src/__fixtures__/leak-cloud-into-ui.ts"
);
const DENYLISTED_DEP_INTO_DAEMON = resolve(
  REPO_ROOT,
  "packages/data/src/__fixtures__/denylisted-dep-into-daemon.ts"
);

// Run the guard and return its process exit code (0 on clean, non-zero on a
// flagged violation). execFileSync throws with a numeric `status` on non-zero.
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

test("the tier-boundary guard exits 0 on the clean repo graph (non-vacuous self-test, clean direction)", () => {
  expect(runGuard(["--root", REPO_ROOT])).toBe(0);
});

test("the guard exits non-zero on a *.cloud.ts-into-apps/web leak fixture (concrete-impl-into-UI direction)", () => {
  // A guard that cannot flag the cloud-into-UI leak is worthless.
  expect(runGuard(["--scan", LEAK_CLOUD_INTO_UI])).not.toBe(0);
});

test("the guard exits non-zero on a denylisted cloud/WASM dep reachable in the daemon/seam graph (denylist direction)", () => {
  // Second direction: a denylisted specifier (e.g. @surrealdb/wasm /
  // @electric-sql/pglite) pulled into the daemon graph must trip the guard —
  // proving both bundles are covered, not just the UI leak.
  expect(runGuard(["--scan", DENYLISTED_DEP_INTO_DAEMON])).not.toBe(0);
});
