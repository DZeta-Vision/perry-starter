/// <reference types="node" />
// The THIN-scope guard. The deliverable is a pure identifier rewrite over the
// existing tree, NOT a heavyweight project generator. This gate proves the
// rename/removal scripts stay dependency-free (no third-party runtime import,
// mirroring scripts/meta-gate.mjs + scripts/tier-boundary-guard.mjs) and that no
// `create-*` generator `bin` or template-scaffolding engine rides in.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url)); // repo-root /scripts
const REPO_ROOT = resolve(HERE, "..");
const RENAME_SCRIPT = join(HERE, "rename.mjs");
const REMOVE_SCRIPT = join(HERE, "remove-reference.mjs");
const RENAME_MANIFEST = join(HERE, "rename-manifest.mjs");

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "_bmad-output",
  "dist",
  ".alchemy",
]);

// Every module specifier the script imports (matchAll does not mutate the regex).
const FROM_RE = /\bfrom\s*["']([^"']+)["']/g;
const SIDE_EFFECT_RE = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_RE = /\bimport\s*\(\s*["']([^"']+)["']/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']/g;
const SPECIFIER_PATTERNS = [
  FROM_RE,
  SIDE_EFFECT_RE,
  DYNAMIC_RE,
  REQUIRE_RE,
] as const;

// A third-party runtime dependency is a specifier that is neither a `node:`
// builtin nor a relative internal module. A templating/codemod package (e.g.
// `fs-extra`) would creep in as a bare specifier; the single-source sibling
// manifest (`./rename-manifest.mjs`) is legitimate internal composition, not a
// dependency, so relative specifiers are allowed.
const isNonNodeImport = (specifier: string): boolean =>
  !(specifier.startsWith("node:") || specifier.startsWith("."));

const specifiersOf = (text: string): string[] => {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      found.push(match[1]);
    }
  }
  return found;
};

const nonNodeImportsIn = (file: string): string[] =>
  specifiersOf(readFileSync(file, "utf8")).filter(isNonNodeImport);

const readDir = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

// Collect every package.json `bin` map name across the repo.
const collectBinNames = (dir: string, out: string[]): void => {
  for (const entry of readDir(dir)) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        collectBinNames(join(dir, entry.name), out);
      }
    } else if (entry.isFile() && entry.name === "package.json") {
      const pkg = JSON.parse(readFileSync(join(dir, entry.name), "utf8")) as {
        bin?: string | Record<string, string>;
      };
      if (typeof pkg.bin === "string") {
        out.push(entry.name);
      } else if (pkg.bin) {
        out.push(...Object.keys(pkg.bin));
      }
    }
  }
};

// A project-scaffolding generator binary (e.g. `create-acme-app`) — the exact
// heavyweight-generator shape the thin rename must never grow into.
const GENERATOR_BIN_NAME = /^create-/;
const isGeneratorBin = (name: string): boolean => GENERATOR_BIN_NAME.test(name);

interface RenameManifestModule {
  readonly renameManifest: {
    readonly categories: readonly unknown[];
    // A thin rename exports an enumerated SET only — never a generator factory.
    readonly generate?: unknown;
    readonly scaffold?: unknown;
  };
}

describe("the deliverable stays the THIN rename, not a heavyweight generator", () => {
  test("scripts/rename.mjs imports only node:* (dependency-free)", () => {
    expect(existsSync(RENAME_SCRIPT)).toBe(true);
    expect(nonNodeImportsIn(RENAME_SCRIPT)).toEqual([]);
  });

  test("scripts/remove-reference.mjs imports only node:* (dependency-free)", () => {
    expect(existsSync(REMOVE_SCRIPT)).toBe(true);
    expect(nonNodeImportsIn(REMOVE_SCRIPT)).toEqual([]);
  });

  test("no create-* project-generator bin entry is registered in any package.json", () => {
    const binNames: string[] = [];
    collectBinNames(REPO_ROOT, binNames);
    expect(binNames.filter(isGeneratorBin)).toEqual([]);
  });

  test("no template-scaffolding generation directory is wired into the repo", () => {
    const scaffoldDir = join(REPO_ROOT, "templates");
    const isDir =
      existsSync(scaffoldDir) && statSync(scaffoldDir).isDirectory();
    expect(isDir).toBe(false);
  });

  test("the manifest is a fixed enumerated set with no project-generation step", async () => {
    const mod: RenameManifestModule = await import(RENAME_MANIFEST);
    expect(Array.isArray(mod.renameManifest.categories)).toBe(true);
    expect(typeof mod.renameManifest.generate).not.toBe("function");
    expect(typeof mod.renameManifest.scaffold).not.toBe("function");
  });
});
