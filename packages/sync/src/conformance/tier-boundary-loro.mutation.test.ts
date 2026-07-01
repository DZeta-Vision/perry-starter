import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Mutation twin for tier-boundary-loro.gate.test.ts. Proves the Loro leg of the
// guard is NON-VACUOUS in BOTH directions, and is TIER-SCOPED (not a blanket
// ban):
//   - a synthetic daemon file importing the loro engine makes `--root` exit
//     non-zero AND names the daemon-denylist direction;
//   - a clean daemon file exits 0 (the detector is not always-red);
//   - the SAME loro import in the BROWSER tier (apps/web) does NOT trip the
//     daemon-denylist — Loro is legal in the browser, foreclosed only in the
//     daemon graph. A blanket ban would wrongly flag this and is caught here.
//
// Synthetic roots are built in an OS temp dir and removed in finally.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const GUARD = resolve(REPO_ROOT, "scripts", "tier-boundary-guard.mjs");

const LORO_ENGINE = ["loro", "crdt"].join("-");

const loroImport = (): string =>
  [
    `import { LoroDoc } from ${JSON.stringify(LORO_ENGINE)};`,
    "export const doc = LoroDoc;",
    "",
  ].join("\n");

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
  const root = mkdtempSync(join(tmpdir(), "perry-sync-loro-tier-mut-"));
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

describe("the guard's Loro leg fires in the daemon graph but allows Loro in the browser", () => {
  test("a synthetic daemon file importing the loro engine makes --root exit non-zero AND names the daemon-denylist direction", () => {
    const root = makeSyntheticRoot([
      {
        contents: loroImport(),
        relPath: join("apps", "daemon", "src", "leak.ts"),
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

  test("a clean synthetic daemon file importing only a benign dep exits 0 (not always-red)", () => {
    const root = makeSyntheticRoot([
      {
        contents: BENIGN_DAEMON_SOURCE,
        relPath: join("packages", "data", "src", "store.ts"),
      },
    ]);
    try {
      expect(runGuardCaptured(["--root", root]).status).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("the SAME loro import in the browser tier (apps/web) does NOT trip the daemon-denylist", () => {
    const root = makeSyntheticRoot([
      {
        contents: loroImport(),
        relPath: join("apps", "web", "src", "lib", "crdt", "editor.ts"),
      },
    ]);
    try {
      const result = runGuardCaptured(["--root", root]);
      expect(result.output).not.toContain("denylisted-dep-into-daemon");
      expect(result.status).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
