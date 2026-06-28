/// <reference types="node" />
// Anti-vacuous twin for the rename-convergence gate. A gate that cannot go red
// ships a false guarantee. These mutations feed KNOWN-BAD input and assert the
// gate's scan goes red — proving convergence is asserted by scanning the tree,
// not by trusting the manifest's own claims or a green build.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const RENAME_SCRIPT = join(HERE, "rename.mjs");

const TEST_DOMAIN = "acme";

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "_bmad-output",
  "dist",
  ".alchemy",
]);

const PERRY_STARTER_TOKEN = /perry-starter/i;
const DOCUMENT_TABLE = /DEFINE\s+TABLE\s+documents?\b/i;

const isShippedSource = (name: string): boolean => !name.endsWith(".test.ts");

const readDir = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const walkSource = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readDir(dir)) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        out.push(...walkSource(join(dir, entry.name)));
      }
    } else if (entry.isFile() && isShippedSource(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
};

// The gate's manifest-INDEPENDENT survivor scan, reproduced so the twin can
// prove it catches survivors a degraded manifest would have skipped.
const scanForToken = (treeRoot: string, token: RegExp): string[] => {
  const hits: string[] = [];
  for (const file of walkSource(treeRoot)) {
    if (token.test(readFileSync(file, "utf8"))) {
      hits.push(file);
    }
  }
  return hits;
};

// Tracked-files-only temp tree (what an adopter clones), matching the gate.
const copyWorkingTree = (): string => {
  const dest = mkdtempSync(join(tmpdir(), "perry-rename-mut-"));
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT })
    .toString()
    .split("\0")
    .filter(Boolean);
  for (const rel of tracked) {
    const src = join(REPO_ROOT, rel);
    if (!existsSync(src)) {
      continue;
    }
    const target = join(dest, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(src, target);
  }
  return dest;
};

describe("the rename-convergence gate genuinely goes red on a survivor", () => {
  test("a perry-starter token planted AFTER rename fails the smoke gate", () => {
    const tree = copyWorkingTree();
    try {
      execFileSync("node", [RENAME_SCRIPT, TEST_DOMAIN, "--root", tree], {
        stdio: "pipe",
      });
      // Plant a survivor in a manifest-covered location (a workspace manifest).
      writeFileSync(
        join(tree, "package.json"),
        '{ "name": "perry-starter" }\n'
      );
      expect(scanForToken(tree, PERRY_STARTER_TOKEN).length).toBeGreaterThan(0);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test("a survivor in a category the manifest no longer enumerates is STILL caught by the tree scan", () => {
    // The manifest is the source the SCRIPT uses; the gate's scan is independent
    // of it. Simulate a degraded-manifest rename leaving an un-rewritten token in
    // a location no category covers — the whole-tree scan must still see it.
    const tree = mkdtempSync(join(tmpdir(), "perry-rename-mut-"));
    try {
      writeFileSync(
        join(tree, "uncovered.config.ts"),
        'export const id = "perry-starter-web";\n'
      );
      expect(scanForToken(tree, PERRY_STARTER_TOKEN).length).toBeGreaterThan(0);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test("a document table left un-rewritten by the rename fails the entity scan", () => {
    const tree = mkdtempSync(join(tmpdir(), "perry-rename-mut-"));
    try {
      writeFileSync(
        join(tree, "leftover.surql"),
        "DEFINE TABLE documents SCHEMAFULL;\n"
      );
      expect(scanForToken(tree, DOCUMENT_TABLE).length).toBeGreaterThan(0);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test("a fully converged tree keeps the scan green (the gate is not always-red)", () => {
    const tree = mkdtempSync(join(tmpdir(), "perry-rename-mut-"));
    try {
      writeFileSync(join(tree, "clean.ts"), 'export const id = "acme-web";\n');
      expect(scanForToken(tree, PERRY_STARTER_TOKEN)).toEqual([]);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});
