/// <reference types="node" />
// Conformance gate: at epic close, every story file reflects execution state.
//
// Runs the REAL guard (scripts/epic-close-doc-guard.mjs) over a temp fixture of
// well-formed story files (status done + Dev Agent Record, no contradictory
// banner) and asserts it passes. The mutation twin proves it reddens on drift.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const doneStory = (title: string) =>
  `Status: done\n\n# ${title}\n\nContext and acceptance criteria here.\n\n## Dev Agent Record\n\n**Status:** done — shipped and merged.\nDelivered the behavior; suite green.\n`;

const PASSED_MSG = /PASSED/;

describe("at epic close, story files reflect execution state", () => {
  test("the guard script exists", () => {
    expect(existsSync(GUARD)).toBe(true);
  });

  test("an epic whose stories are all written back passes", () => {
    const dir = mkdtempSync(join(tmpdir(), "epic-close-ok-"));
    try {
      writeFileSync(join(dir, "3-1-first-thing.md"), doneStory("First thing"));
      writeFileSync(
        join(dir, "3-2-second-thing.md"),
        doneStory("Second thing")
      );
      // A retro file for the same epic must be ignored, not required.
      writeFileSync(join(dir, "epic-3-retro-2026-07-01.md"), "retro notes\n");
      const result = runGuard(["--epic", "3", "--dir", dir]);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(PASSED_MSG);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
