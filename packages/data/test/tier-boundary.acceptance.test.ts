import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

// --- --root scan wiring (UI_ROOTS + DAEMON_GRAPH_ROOTS) --------------------
//
// The tests above exercise only --scan (a single file). The --root mode joins
// the UI roots (apps/web/src) and the daemon-graph roots (packages/{data,ai}/
// src, apps/daemon) under the passed directory and walks each. To prove that
// wiring fails on a planted violation WITHOUT mutating the real repo tree, we
// synthesize a throwaway root in an OS temp dir that mirrors the scanned layout,
// run the guard against it, and remove it in a finally block. Nothing is ever
// written under the repo.

// A type-only seam-interface import — the allowed shape for UI code.
const SEAM_INTERFACE_SOURCE = [
  'import type { DocumentsDataSeam } from "@perry-starter/data/documents";',
  "export type Seam = DocumentsDataSeam;",
  "",
].join("\n");

// A concrete *.cloud impl pulled into UI code — the concrete-impl-into-UI leak.
const CONCRETE_IMPL_LEAK_SOURCE = [
  'import { documentsData } from "@perry-starter/data/documents.cloud";',
  "export const leaked = documentsData;",
  "",
].join("\n");

// A denylisted cloud/WASM dep pulled into the daemon graph — the other leak.
const DENYLISTED_DEP_LEAK_SOURCE = [
  'import { PGlite } from "@electric-sql/pglite";',
  "export const forbidden = PGlite;",
  "",
].join("\n");

// A benign daemon-graph source whose only import is allowed.
const BENIGN_DAEMON_SOURCE = [
  'import { z } from "zod";',
  "export const ok = z;",
  "",
].join("\n");

interface PlantedFile {
  contents: string;
  relPath: string;
}

// Build a synthetic repo root in an OS temp dir, planting each file at its
// relative path. The caller owns removal.
const makeSyntheticRoot = (files: readonly PlantedFile[]): string => {
  const root = mkdtempSync(join(tmpdir(), "perry-tier-root-"));
  for (const file of files) {
    const full = join(root, file.relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.contents);
  }
  return root;
};

// Run the guard and capture both the exit status and the combined output, so a
// --root run can be asserted to fire on BOTH root-sets.
const runGuardCaptured = (
  args: string[]
): { output: string; status: number } => {
  try {
    const stdout = execFileSync(process.execPath, [GUARD, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return { output: stdout, status: 0 };
  } catch (error) {
    const err = error as {
      status?: number;
      stderr?: string;
      stdout?: string;
    };
    const status = typeof err.status === "number" ? err.status : 1;
    return { output: `${err.stdout ?? ""}${err.stderr ?? ""}`, status };
  }
};

test("the guard's --root scan flags a planted UI-leak AND a planted daemon-denylist import in a synthetic temp root (both root-sets wired)", () => {
  const root = makeSyntheticRoot([
    {
      relPath: join("apps", "web", "src", "leak.ts"),
      contents: CONCRETE_IMPL_LEAK_SOURCE,
    },
    {
      relPath: join("packages", "data", "src", "leak.ts"),
      contents: DENYLISTED_DEP_LEAK_SOURCE,
    },
  ]);
  try {
    const result = runGuardCaptured(["--root", root]);
    // Non-zero exit AND both root-sets named — the UI_ROOTS walk and the
    // DAEMON_GRAPH_ROOTS walk both fired under --root.
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("concrete-impl-into-UI");
    expect(result.output).toContain("denylisted-dep-into-daemon");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the guard's --root scan exits 0 on a clean synthetic temp root that imports only the seam interface and benign deps", () => {
  const root = makeSyntheticRoot([
    {
      relPath: join("apps", "web", "src", "ui.ts"),
      contents: SEAM_INTERFACE_SOURCE,
    },
    {
      relPath: join("packages", "data", "src", "store.ts"),
      contents: BENIGN_DAEMON_SOURCE,
    },
  ]);
  try {
    expect(runGuardCaptured(["--root", root]).status).toBe(0);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
