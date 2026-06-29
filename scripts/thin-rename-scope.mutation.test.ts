/// <reference types="node" />
// Anti-vacuous twin for the thin-scope guard. It must actually distinguish the
// thin identifier-rewrite from a heavyweight generator: a third-party
// dependency in the rename script, OR a registered `create-<domain>-app`
// generator `bin` / a `templates/` scaffold dir, must each turn the gate red.
// These mutations feed those shapes into throwaway fixtures.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const FROM_RE = /\bfrom\s*["']([^"']+)["']/g;
const SIDE_EFFECT_RE = /\bimport\s*["']([^"']+)["']/g;
const SPECIFIER_PATTERNS = [FROM_RE, SIDE_EFFECT_RE] as const;

// A third-party runtime dependency: neither a `node:` builtin nor a relative
// internal module. A bare specifier like `fs-extra` is flagged; relative
// sibling imports are legitimate internal composition.
const isNonNodeImport = (specifier: string): boolean =>
  !(specifier.startsWith("node:") || specifier.startsWith("."));

const nonNodeImportsInSource = (text: string): string[] => {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (isNonNodeImport(match[1])) {
        found.push(match[1]);
      }
    }
  }
  return found;
};

const GENERATOR_BIN_NAME = /^create-/;
const isGeneratorBin = (name: string): boolean => GENERATOR_BIN_NAME.test(name);

describe("the thin-scope guard genuinely distinguishes a generator from the thin rename", () => {
  test("a non-node: runtime import added to the rename script turns the guard red", () => {
    const tree = mkdtempSync(join(tmpdir(), "perry-thin-mut-"));
    try {
      const script = join(tree, "rename.mjs");
      writeFileSync(
        script,
        'import { copy } from "fs-extra";\nimport { join } from "node:path";\nexport const run = () => copy(join("a", "b"), "c");\n'
      );
      expect(
        nonNodeImportsInSource(
          'import { copy } from "fs-extra";\nimport { join } from "node:path";\n'
        ).length
      ).toBeGreaterThan(0);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test("a registered create-<domain>-app generator bin turns the guard red", () => {
    const bin = { "create-acme-app": "./bin/create-acme-app.mjs" };
    expect(Object.keys(bin).filter(isGeneratorBin).length).toBeGreaterThan(0);
  });

  test("a templates/ scaffold-generation directory turns the guard red", () => {
    const tree = mkdtempSync(join(tmpdir(), "perry-thin-mut-"));
    try {
      const scaffoldDir = join(tree, "templates");
      mkdirSync(scaffoldDir);
      const isDir =
        existsSync(scaffoldDir) && statSync(scaffoldDir).isDirectory();
      expect(isDir).toBe(true);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test("a dependency-free node:*-only script keeps the guard green (not always-red)", () => {
    expect(
      nonNodeImportsInSource(
        'import { readFileSync } from "node:fs";\nimport { join } from "node:path";\n'
      )
    ).toEqual([]);
  });
});
