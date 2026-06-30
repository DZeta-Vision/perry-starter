/// <reference types="node" />
// Anti-vacuous twin for the epic-close documentation guard. The gate promises a
// story file that still reads as a red-phase scaffold blocks the epic close.
// This twin feeds known-bad story fixtures to the REAL guard and asserts it goes
// red — so a "done" verdict can never pass vacuously — and confirms a well-formed
// epic is NOT flagged (not always-red), plus a story-less epic is refused.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, "epic-close-doc-guard.mjs");

const runGuard = (args: string[]) => {
  try {
    const stdout = execFileSync("node", [GUARD, ...args], {
      stdio: "pipe",
    }).toString();
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      code: err.status ?? 1,
      stdout: (err.stdout ?? Buffer.from("")).toString(),
      stderr: (err.stderr ?? Buffer.from("")).toString(),
    };
  }
};

const withDir = (run: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "epic-close-mut-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const doneStory =
  "Status: done\n\n# A thing\n\n## Dev Agent Record\n\n**Status:** done — shipped.\n";

const NO_RECORD_MSG = /no Dev Agent Record/;
const CONTRADICTORY_MSG = /contradictory/;

describe("the epic-close guard genuinely reddens on doc drift", () => {
  test("a story missing its Dev Agent Record blocks the close", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "5-1-ok.md"), doneStory);
      writeFileSync(
        join(dir, "5-2-no-record.md"),
        "Status: done\n\n# Half-written\n\nContext only; nothing written back yet.\n"
      );
      const result = runGuard(["--epic", "5", "--dir", dir]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(NO_RECORD_MSG);
    });
  });

  test("a story whose Status still reads a contradictory unfinished state blocks the close", () => {
    withDir((dir) => {
      writeFileSync(
        join(dir, "5-1-stale.md"),
        "Status: ready-for-dev\n\n# Stale scaffold\n\n## Dev Agent Record\n\n(empty)\n"
      );
      const result = runGuard(["--epic", "5", "--dir", dir]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(CONTRADICTORY_MSG);
    });
  });

  test("a story flatly banner-ed NOT YET IMPLEMENTED blocks the close", () => {
    withDir((dir) => {
      writeFileSync(
        join(dir, "5-1-lie.md"),
        "Status: done\n\n# Lying banner\n\nNOT YET IMPLEMENTED\n\n## Dev Agent Record\n\nx\n"
      );
      const result = runGuard(["--epic", "5", "--dir", dir]);
      expect(result.code).toBe(1);
    });
  });

  test("an epic with no story files is refused, not passed vacuously", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "epic-9-retro.md"), "just a retro\n");
      const result = runGuard(["--epic", "9", "--dir", dir]);
      expect(result.code).toBe(1);
    });
  });

  test("a fully written-back epic is NOT flagged (not always-red)", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "6-1-a.md"), doneStory);
      writeFileSync(join(dir, "6-2-b.md"), doneStory);
      const result = runGuard(["--epic", "6", "--dir", dir]);
      expect(result.code).toBe(0);
    });
  });
});
