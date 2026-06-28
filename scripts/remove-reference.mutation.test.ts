/// <reference types="node" />
// Anti-vacuous twin for the documents-removal gate. The gate makes two
// promises: ZERO surviving documents-entity references across the FULL family
// (db export + data default + data/documents{,.local,.cloud} seam + symbols +
// registry key), and a structurally CONSISTENT post-removal tree (every import
// of a changed package still resolves). This twin feeds known-bad inputs and
// asserts BOTH detectors go red — so neither promise can pass vacuously.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

// The gate's documents-reference patterns (kept in sync with the gate).
const DOC_REFERENCE_PATTERNS = [
  /DEFINE\s+TABLE\s+documents\b/i,
  /@perry-starter\/db\/documents\b/,
  /(?:from|import\()\s*["']@perry-starter\/data["']/,
  /@perry-starter\/data\/documents(?:\.local|\.cloud)?\b/,
  /\bdocuments\s*:\s*["']/,
  /["'`]\/documents["'`]/,
  /\bdocuments\.(?:surql|ts|local\.ts|cloud\.ts)\b/,
  /\bdocumentsEntitySchema\b/,
  /\bcreateDocumentsLocal\b/,
  /\bdocumentsData\b/,
  /collaborationModeRegistry\.documents\b/,
] as const;

const scanText = (source: string): string[] =>
  DOC_REFERENCE_PATTERNS.filter((pattern) => pattern.test(source)).map(
    (pattern) => pattern.source
  );

// The gate's meta-tooling exclusion (kept in sync with the gate). It must be
// EXACTLY the rename/removal machinery — nothing in the product surface.
const META_TOOLING = new Set([
  "scripts/rename.mjs",
  "scripts/remove-reference.mjs",
  "scripts/rename-manifest.mjs",
  "scripts/rename.gate.test.ts",
  "scripts/rename.mutation.test.ts",
  "scripts/remove-reference.gate.test.ts",
  "scripts/remove-reference.mutation.test.ts",
  "scripts/thin-rename-scope.gate.test.ts",
  "scripts/thin-rename-scope.mutation.test.ts",
]);

// A path-aware mirror of the gate's product-surface scan: scan every file
// except the excluded meta-tooling.
const walkAll = (dir: string, out: string[]): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      walkAll(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
};

const findProductDocRefs = (treeRoot: string): string[] => {
  const files: string[] = [];
  walkAll(treeRoot, files);
  const hits: string[] = [];
  for (const file of files) {
    if (META_TOOLING.has(file.slice(treeRoot.length + 1))) {
      continue;
    }
    if (scanText(readFileSync(file, "utf8")).length > 0) {
      hits.push(file.slice(treeRoot.length + 1));
    }
  }
  return hits;
};

// A minimal mirror of the gate's workspace resolver: a `@perry-starter/data`
// subpath import resolves only if the data package's `exports` still lists it.
const FROM_RE = /\bfrom\s*["']([^"']+)["']/g;
const LEADING_SLASH = /^\//;
const resolvesAgainstExports = (
  importLine: string,
  dataExports: Record<string, string>
): boolean => {
  const match = [...importLine.matchAll(FROM_RE)][0];
  const spec = match?.[1] ?? "";
  if (!spec.startsWith("@perry-starter/data")) {
    return true;
  }
  const sub = spec
    .slice("@perry-starter/data".length)
    .replace(LEADING_SLASH, "");
  const key = sub ? `./${sub}` : ".";
  return key in dataExports;
};

describe("the documents-removal gate genuinely goes red on bad input", () => {
  test("a surviving import of the removed data seam family is detected (full family, not just db/documents)", () => {
    expect(
      scanText(
        'import { documentsData } from "@perry-starter/data/documents.local";'
      ).length
    ).toBeGreaterThan(0);
    expect(
      scanText('import * as seam from "@perry-starter/data";').length
    ).toBeGreaterThan(0);
    expect(
      scanText(
        'import { documentsEntitySchema } from "@perry-starter/db/documents";'
      ).length
    ).toBeGreaterThan(0);
  });

  test("a surviving registry access to the removed documents key is detected", () => {
    expect(
      scanText("expect(collaborationModeRegistry.documents).toBeDefined();")
        .length
    ).toBeGreaterThan(0);
  });

  test("the structural resolver flags a consumer left dangling on a removed export", () => {
    // The data package no longer exports `./documents.local`; a leftover
    // consumer importing it must be reported as unresolved.
    const prunedExports = { "./surreal-http": "./src/surreal-http.ts" };
    const dangling =
      'import { documentsData } from "@perry-starter/data/documents.local";';
    expect(resolvesAgainstExports(dangling, prunedExports)).toBe(false);
    // A surviving export still resolves (not always-red).
    const ok = 'import { sql } from "@perry-starter/data/surreal-http";';
    expect(resolvesAgainstExports(ok, prunedExports)).toBe(true);
  });

  test("a genuinely decoupled file is clean under both detectors (not always-red)", () => {
    const tree = mkdtempSync(join(tmpdir(), "perry-remove-mut-"));
    try {
      const file = join(tree, "clean.ts");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        'import { z } from "zod";\nexport const schema = z.string();\n'
      );
      expect(existsSync(file)).toBe(true);
      expect(scanText(readFileSync(file, "utf8"))).toEqual([]);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test("the meta-tooling exclusion is NARROW: a planted PRODUCT-surface ref still reddens; only the tooling source is exempt", () => {
    const tree = mkdtempSync(join(tmpdir(), "perry-remove-mut-"));
    try {
      const ref =
        'import { documentsEntitySchema } from "@perry-starter/db/documents";\n';
      // A real product-surface consumer (apps/ or packages/) — MUST be caught.
      const productFile = join(tree, "packages", "feature", "src", "uses.ts");
      mkdirSync(dirname(productFile), { recursive: true });
      writeFileSync(productFile, ref);
      // The removal tool's own pattern source — MUST be exempt.
      const toolingFile = join(tree, "scripts", "remove-reference.mjs");
      mkdirSync(dirname(toolingFile), { recursive: true });
      writeFileSync(toolingFile, ref);

      const hits = findProductDocRefs(tree);
      expect(hits).toContain("packages/feature/src/uses.ts");
      expect(hits).not.toContain("scripts/remove-reference.mjs");
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});
