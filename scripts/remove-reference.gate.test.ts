/// <reference types="node" />
// The one-step `documents` reference removal. The generic `documents` reference
// entity is removable-by-construction in ONE documented step
// (`scripts/remove-reference.mjs --root <tmp>`); after that single operation the
// remaining tree carries ZERO documents-entity references AND is internally
// consistent — every internal import resolves to a file/export that still
// exists, so a removed adopter tree still type-checks and collects.
//
// This gate is deliberately NON-vacuous: it scans the FULL documents family
// (the `@perry-starter/db/documents` export AND the `@perry-starter/data`
// default + `@perry-starter/data/documents{,.local,.cloud}` seam family), it
// INCLUDES `*.test.ts` and `src` fixtures in the scan (a dangling consumer is
// most often a test or a fixture), and it structurally resolves every internal
// import so a dangling consumer the string scan might miss is still caught.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const REMOVE_SCRIPT = join(HERE, "remove-reference.mjs");

// Every form a surviving `documents`-entity reference can take. Context-scoped
// so the unrelated `RootDocument`, the canonical `documentSchema` /
// `documentProjectionSchema` shapes, and the legitimate `@perry-starter/data`
// PACKAGE name (in lockfiles/manifests) are never matched — only an actual
// documents import, store symbol, table, registry key, route, or file ref is.
const DOC_REFERENCE_PATTERNS = [
  /DEFINE\s+TABLE\s+documents\b/i,
  /@perry-starter\/db\/documents\b/,
  /(?:from|import\()\s*["']@perry-starter\/data["']/, // the seam default import
  /@perry-starter\/data\/documents(?:\.local|\.cloud)?\b/,
  /\bdocuments\s*:\s*["']/,
  /["'`]\/documents["'`]/,
  /\bdocuments\.(?:surql|ts|local\.ts|cloud\.ts)\b/,
  /\bdocumentsEntitySchema\b/,
  /\bcreateDocumentsLocal\b/,
  /\bdocumentsData\b/,
  /collaborationModeRegistry\.documents\b/,
] as const;

const SCAN_SKIP_DIRS = new Set(["node_modules", ".git"]);
const SOURCE_EXT = /\.[mc]?tsx?$/;

const readDir = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const walkAll = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readDir(dir)) {
    if (entry.isDirectory()) {
      if (!SCAN_SKIP_DIRS.has(entry.name)) {
        out.push(...walkAll(join(dir, entry.name)));
      }
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
};

// Whole-tree string scan — INCLUDING tests and fixtures.
const findDocReferences = (treeRoot: string): string[] => {
  const hits: string[] = [];
  for (const file of walkAll(treeRoot)) {
    const source = readFileSync(file, "utf8");
    for (const pattern of DOC_REFERENCE_PATTERNS) {
      if (pattern.test(source)) {
        hits.push(`${file.slice(treeRoot.length)}: ${pattern.source}`);
      }
    }
  }
  return hits;
};

// ---- structural import resolution ------------------------------------------
// Build the set of resolvable `@perry-starter/*` specifiers from every
// package.json `exports` map, then assert every internal import in the tree
// resolves to a file/export that still exists.

interface PackageEntry {
  readonly hasExports: boolean;
  readonly keys: Set<string>;
  readonly wildcard: boolean;
}

const buildPackageIndex = (treeRoot: string): Map<string, PackageEntry> => {
  const index = new Map<string, PackageEntry>();
  for (const file of walkAll(treeRoot)) {
    if (!file.endsWith("package.json")) {
      continue;
    }
    const pkg = JSON.parse(readFileSync(file, "utf8")) as {
      name?: string;
      exports?: Record<string, unknown> | string | null;
    };
    if (!pkg.name) {
      continue;
    }
    const keys = new Set<string>();
    if (pkg.exports && typeof pkg.exports === "object") {
      for (const key of Object.keys(pkg.exports)) {
        keys.add(key);
      }
    }
    index.set(pkg.name, {
      hasExports: pkg.exports != null,
      wildcard: keys.has("./*"),
      keys,
    });
  }
  return index;
};

const FROM_RE = /\bfrom\s*["']([^"']+)["']/g;
const SIDE_EFFECT_RE = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_RE = /\bimport\s*\(\s*["']([^"']+)["']/g;
const SPECIFIER_PATTERNS = [FROM_RE, SIDE_EFFECT_RE, DYNAMIC_RE] as const;

const specifiersOf = (text: string): string[] => {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      found.push(match[1]);
    }
  }
  return found;
};

const resolvesWorkspace = (
  spec: string,
  index: Map<string, PackageEntry>
): boolean => {
  const segments = spec.split("/");
  const pkgName = `${segments[0]}/${segments[1]}`;
  const entry = index.get(pkgName);
  if (!entry) {
    return true; // unknown package — out of scope for this resolver
  }
  if (!entry.hasExports || entry.wildcard) {
    return true; // no export map (or a wildcard) resolves any subpath
  }
  const sub = segments.slice(2).join("/");
  const key = sub ? `./${sub}` : ".";
  return entry.keys.has(key);
};

// Scope: only the two packages whose export maps the removal changes
// (`@perry-starter/db` and `@perry-starter/data`). Resolving the whole tree's
// imports via regex would false-positive on import statements embedded in JSDoc
// `@example` comments and in fixture strings; scoping to the changed workspace
// specifiers from non-test source is false-positive-free and still catches a
// surviving consumer (e.g. a src fixture) that imports a removed export.
const isChangedPackageImport = (spec: string): boolean =>
  spec.startsWith("@perry-starter/db") ||
  spec.startsWith("@perry-starter/data");

const findUnresolvedImports = (treeRoot: string): string[] => {
  const index = buildPackageIndex(treeRoot);
  const unresolved: string[] = [];
  for (const file of walkAll(treeRoot)) {
    if (!SOURCE_EXT.test(file) || file.endsWith(".test.ts")) {
      continue;
    }
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      if (isChangedPackageImport(spec) && !resolvesWorkspace(spec, index)) {
        unresolved.push(`${file.slice(treeRoot.length)} -> ${spec}`);
      }
    }
  }
  return unresolved;
};

// Materialize a temp tree from the git-tracked files only (what an adopter
// clones) — gitignored artifacts never enter the removal scan.
const copyWorkingTree = (): string => {
  const dest = mkdtempSync(join(tmpdir(), "perry-remove-gate-"));
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

const runRemoval = (treeRoot: string): void => {
  execFileSync("node", [REMOVE_SCRIPT, "--root", treeRoot], { stdio: "pipe" });
};

describe("the documents reference entity is removable in one documented step", () => {
  test("the single removal step is one named operation, not a multi-file manual checklist", () => {
    expect(existsSync(REMOVE_SCRIPT)).toBe(true);
  });

  test("after the one step, ZERO documents-entity references remain anywhere (tests and fixtures included)", () => {
    const tree = copyWorkingTree();
    try {
      runRemoval(tree);
      expect(findDocReferences(tree)).toEqual([]);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test("the post-removal tree is internally consistent — every internal import still resolves (no dangling consumer)", () => {
    const tree = copyWorkingTree();
    try {
      runRemoval(tree);
      expect(findUnresolvedImports(tree)).toEqual([]);
      // The db `./documents` export module itself is gone (no orphaned producer).
      expect(
        existsSync(join(tree, "packages", "db", "src", "documents.ts"))
      ).toBe(false);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});
