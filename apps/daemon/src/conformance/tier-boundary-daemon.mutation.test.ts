import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Mutation twin for tier-boundary-daemon.gate.test.ts. Proves the daemon-graph
// leg of the guard is NON-VACUOUS in BOTH directions, without mutating the real
// repo tree: a synthetic apps/daemon file importing a denylisted dep makes
// `--root` exit non-zero AND names "denylisted-dep-into-daemon"; a clean
// apps/daemon file exits 0. The synthetic root is built in an OS temp dir and
// removed in a finally block — nothing is ever written under the repo.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const GUARD = resolve(REPO_ROOT, "scripts", "tier-boundary-guard.mjs");

// A denylisted WASM dep pulled into the daemon graph — the leak the guard exists
// to catch. The guard skips `conformance` directories, so this file's own source
// is not scanned; the specifier is still assembled at runtime (rather than as a
// contiguous `from "<dep>"` literal) to keep the twin robust even if that skip
// were ever removed. The temp file written below receives the real import, so
// the guard fires on the synthetic root as intended.
const DENYLISTED_DAEMON_DEP = ["@surrealdb", "wasm"].join("/");
const DENYLISTED_DAEMON_SOURCE = [
  `import { Surreal } from ${JSON.stringify(DENYLISTED_DAEMON_DEP)};`,
  "export const forbidden = Surreal;",
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

const makeSyntheticRoot = (files: readonly PlantedFile[]): string => {
  const root = mkdtempSync(join(tmpdir(), "perry-daemon-tier-root-"));
  for (const file of files) {
    const full = join(root, file.relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.contents);
  }
  return root;
};

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
    const err = error as { status?: number; stderr?: string; stdout?: string };
    const status = typeof err.status === "number" ? err.status : 1;
    return { output: `${err.stdout ?? ""}${err.stderr ?? ""}`, status };
  }
};

describe("the guard's daemon-graph leg fires on a planted denylisted import and stays clean otherwise", () => {
  test("a synthetic apps/daemon file importing @surrealdb/wasm makes --root exit non-zero AND name the daemon-denylist direction", () => {
    const root = makeSyntheticRoot([
      {
        relPath: join("apps", "daemon", "src", "leak.ts"),
        contents: DENYLISTED_DAEMON_SOURCE,
      },
    ]);
    try {
      const result = runGuardCaptured(["--root", root]);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("denylisted-dep-into-daemon");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a clean synthetic apps/daemon file importing only a benign dep exits 0 (not always-red)", () => {
    const root = makeSyntheticRoot([
      {
        relPath: join("apps", "daemon", "src", "store.ts"),
        contents: BENIGN_DAEMON_SOURCE,
      },
    ]);
    try {
      expect(runGuardCaptured(["--root", root]).status).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
