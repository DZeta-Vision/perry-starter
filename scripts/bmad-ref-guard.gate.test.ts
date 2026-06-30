/// <reference types="node" />
// Conformance gate: committed code carries ZERO BMAD planning references.
//
// This runs the REAL guard (scripts/bmad-ref-guard.mjs) two ways: over the live
// tracked tree (it must exit 0 — the actual guarantee shipped to adopters) and
// over a temp fixture with no refs (it must exit 0 — proving the guard is not
// always-red). The mutation twin proves it genuinely reddens on planted ids.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const GUARD = join(HERE, "bmad-ref-guard.mjs");

const runGuard = (args: string[]) => {
  try {
    const stdout = execFileSync("node", [GUARD, ...args], {
      cwd: REPO_ROOT,
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

const ZERO_REFS_MSG = /0 BMAD references/;

describe("committed code is BMAD-agnostic", () => {
  test("the guard script exists", () => {
    expect(existsSync(GUARD)).toBe(true);
  });

  test("the live tracked tree is clean — the guard exits 0", () => {
    const result = runGuard([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(ZERO_REFS_MSG);
  });

  test("a tree with no planning ids passes (the guard is not always-red)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bmad-guard-clean-"));
    try {
      writeFileSync(
        join(dir, "clean.ts"),
        "// the cloud gatekeeper fronts all cloud data\nexport const value = 1;\n"
      );
      const result = runGuard(["--root", dir]);
      expect(result.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
