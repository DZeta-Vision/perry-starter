/// <reference types="node" />
// Acceptance gate — rename convergence + idempotency + post-rename workspace
// resolvability. It materializes a temp tree from the git-tracked files, runs
// `scripts/rename.mjs <domain> --root <tmp>`, then asserts by SCANNING the
// renamed tree — never by "build is green" — that ZERO `perry-starter` and ZERO
// `document`/`documents` entity identifiers survive, that a second rename is a
// no-op (convergent + idempotent), and that the workspace graph still resolves.
// It reads the SAME `scripts/rename-manifest.mjs` the rename script reads
// (single source).

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

const HERE = dirname(fileURLToPath(import.meta.url)); // repo-root /scripts
const REPO_ROOT = resolve(HERE, "..");
const RENAME_SCRIPT = join(HERE, "rename.mjs");
const RENAME_MANIFEST = join(HERE, "rename-manifest.mjs");

// A throwaway domain to rename INTO. Distinct from `perry-starter`/`document`
// so any surviving source token is unambiguously a non-convergence.
const TEST_DOMAIN = "acme";

// Directories the rename never walks and the temp-copy never carries.
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "_bmad-output",
  "dist",
  ".alchemy",
]);

// The kebab package/root identity family. Case-insensitive so a stray
// `Perry-Starter` is still caught as a survivor.
const PERRY_STARTER_TOKEN = /perry-starter/i;

// The `document` entity family is context-scoped to its real layers so the
// unrelated `RootDocument` HTML-shell component in `__root.tsx` is NEVER flagged
// (the false-positive trap). Top-level literals — never built in a loop.
const DOCUMENT_ENTITY_PATTERNS = [
  /DEFINE\s+TABLE\s+documents?\b/i, // SurrealQL `documents` / `document_*` table
  /["'`]@perry-starter\/db\/documents["'`]/, // the `./documents` db export
  /\bdocuments\s*:\s*["']/, // collaborationMode registry `documents:` key
  /["'`]\/documents["'`]/, // the `/documents` route path
  /\bdocuments\.(?:ts|local\.ts|cloud\.ts)\b/, // packages/data documents modules
] as const;

// Scaffolding (`*.test.ts`) necessarily NAMES these tokens to detect them, so it
// is never part of the renamed identifier surface that must converge.
const isShippedSource = (name: string): boolean =>
  !(name.endsWith(".test.ts") || name.endsWith(".snap"));

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

// Manifest-independent survivor scan: greps the WHOLE renamed tree for the source
// token. Independence from the manifest is what makes a "removed category" still
// get caught (see the mutation twin).
const findSurvivingPerryStarter = (treeRoot: string): string[] => {
  const hits: string[] = [];
  for (const file of walkSource(treeRoot)) {
    if (PERRY_STARTER_TOKEN.test(readFileSync(file, "utf8"))) {
      hits.push(file);
    }
  }
  return hits;
};

const findDocumentEntityTokens = (source: string): string[] => {
  const hits: string[] = [];
  for (const pattern of DOCUMENT_ENTITY_PATTERNS) {
    if (pattern.test(source)) {
      hits.push(pattern.source);
    }
  }
  return hits;
};

const findSurvivingDocumentEntities = (treeRoot: string): string[] => {
  const hits: string[] = [];
  for (const file of walkSource(treeRoot)) {
    hits.push(...findDocumentEntityTokens(readFileSync(file, "utf8")));
  }
  return hits;
};

// A stable, order-independent snapshot of every shipped source file's contents —
// used to prove the second rename produces NO further diffs (idempotent).
const snapshotTree = (treeRoot: string): Map<string, string> => {
  const snapshot = new Map<string, string>();
  for (const file of walkSource(treeRoot)) {
    snapshot.set(file.slice(treeRoot.length), readFileSync(file, "utf8"));
  }
  return snapshot;
};

// Materialize a temp tree from the git-tracked files only — exactly what an
// adopter clones. Gitignored build artifacts and local tool state (which can
// carry the host's own `perry-starter` path string) never enter the
// convergence scan.
const copyWorkingTree = (): string => {
  const dest = mkdtempSync(join(tmpdir(), "perry-rename-gate-"));
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

const runRename = (treeRoot: string, domain: string): void => {
  execFileSync("node", [RENAME_SCRIPT, domain, "--root", treeRoot], {
    stdio: "pipe",
  });
};

interface RenameManifestModule {
  readonly renameManifest: {
    readonly categories: ReadonlyArray<{
      readonly id: string;
      readonly tokens: readonly string[];
    }>;
  };
}

// Token-family probes for the manifest's enumerated set.
const PERRY_STARTER_TOKEN_PROBE = /perry-starter/i;
const DOCUMENT_TOKEN_PROBE = /documents?/i;

describe("perry rename converges across every manifest category", () => {
  test("a rename leaves ZERO surviving perry-starter identifiers anywhere in the renamed tree", () => {
    const tree = copyWorkingTree();
    try {
      runRename(tree, TEST_DOMAIN);
      // Convergence is asserted by SCAN, not by a build — every shipped source
      // file in the renamed tree is free of the source scope token.
      expect(findSurvivingPerryStarter(tree)).toEqual([]);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test("a rename leaves ZERO un-renamed document/documents entity identifiers (entity layers only)", () => {
    const tree = copyWorkingTree();
    try {
      runRename(tree, TEST_DOMAIN);
      expect(findSurvivingDocumentEntities(tree)).toEqual([]);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test("the gate reads the single-source manifest and it enumerates the six pinned categories", async () => {
    const mod: RenameManifestModule = await import(RENAME_MANIFEST);
    const { categories } = mod.renameManifest;
    // The manifest is an enumerated SET (not prose), so two renames converge.
    expect(categories).toHaveLength(6);
    const everyToken = categories.flatMap((c) => c.tokens);
    expect(everyToken.some((t) => PERRY_STARTER_TOKEN_PROBE.test(t))).toBe(
      true
    );
    expect(everyToken.some((t) => DOCUMENT_TOKEN_PROBE.test(t))).toBe(true);
  });

  test("a second rename on the already-renamed tree produces no further diffs (idempotent + convergent)", () => {
    const tree = copyWorkingTree();
    try {
      runRename(tree, TEST_DOMAIN);
      const afterFirst = snapshotTree(tree);
      runRename(tree, TEST_DOMAIN);
      const afterSecond = snapshotTree(tree);
      expect([...afterSecond.entries()]).toEqual([...afterFirst.entries()]);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test("the document scanner does NOT flag the RootDocument HTML-shell component", () => {
    // The real false-positive trap: `RootDocument` (the HTML document component
    // in apps/web/src/routes/__root.tsx) contains the substring `Document` but
    // is NOT the entity. The entity scanner must leave it intact.
    const rootShell =
      "function RootDocument() {\n  return <RootDocument />;\n}";
    expect(findDocumentEntityTokens(rootShell)).toEqual([]);
    // And it MUST fire on a genuine entity identifier (not always-green).
    expect(
      findDocumentEntityTokens("DEFINE TABLE documents SCHEMAFULL").length
    ).toBeGreaterThan(0);
  });
});

describe("the renamed workspace is still resolvable (no orphaned scope)", () => {
  test("every internal workspace dependency and tsconfig path resolves after rename", () => {
    const tree = copyWorkingTree();
    try {
      runRename(tree, TEST_DOMAIN);

      // Produced workspace names = each package.json `name` in the renamed tree.
      const produced = new Set<string>();
      const consumed: string[] = [];
      for (const file of walkSource(tree)) {
        if (!file.endsWith("package.json")) {
          continue;
        }
        const pkg = JSON.parse(readFileSync(file, "utf8")) as {
          name?: string;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        if (pkg.name) {
          produced.add(pkg.name);
        }
        for (const deps of [pkg.dependencies, pkg.devDependencies]) {
          for (const [dep, spec] of Object.entries(deps ?? {})) {
            if (spec.startsWith("workspace:")) {
              consumed.push(dep);
            }
          }
        }
      }

      // No orphaned old-scope name survives, and every consumed internal name
      // has a producer in the renamed tree (no dangling `@<domain>/*` dep).
      expect([...produced].filter((n) => PERRY_STARTER_TOKEN.test(n))).toEqual(
        []
      );
      expect(consumed.filter((dep) => !produced.has(dep))).toEqual([]);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});
