/// <reference types="node" />
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const FORBIDDEN_DOMAIN_TOKENS = [
  /\bgmc\b/i,
  /\bmaths-club\b/i,
  /\bmaths_club\b/i,
  /\bnote\b/i,
] as const;

const isShippedSource = (name: string): boolean =>
  name.endsWith(".ts") && !name.endsWith(".test.ts");

const readDir = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const walk = (dir: string, match: (name: string) => boolean): string[] => {
  const out: string[] = [];
  for (const entry of readDir(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        out.push(...walk(full, match));
      }
    } else if (entry.isFile() && match(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

const findForbiddenTokens = (source: string): string[] => {
  const hits: string[] = [];
  for (const re of FORBIDDEN_DOMAIN_TOKENS) {
    if (re.test(source)) {
      hits.push(re.source);
    }
  }
  return hits;
};

// Run the gate's exact FS scan over a throwaway tree.
const scanTree = (dir: string): string[] => {
  const hits: string[] = [];
  for (const file of walk(dir, isShippedSource)) {
    hits.push(...findForbiddenTokens(readFileSync(file, "utf8")));
  }
  return hits;
};

describe("the domain-neutrality scanner fires on planted coupling", () => {
  test("a planted domain-coupled module makes the source scan go red", () => {
    const dir = mkdtempSync(join(tmpdir(), "db-domain-neutrality-"));
    try {
      writeFileSync(
        join(dir, "leak.ts"),
        'export const club = "maths-club";\n'
      );
      expect(scanTree(dir).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a clean module in the same tree keeps the scan green (not always-red)", () => {
    const dir = mkdtempSync(join(tmpdir(), "db-domain-neutrality-"));
    try {
      writeFileSync(
        join(dir, "clean.ts"),
        'export const title = "Untitled";\n'
      );
      expect(scanTree(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the detector fires on every forbidden domain token", () => {
    expect(findForbiddenTokens("const gmc = 1;").length).toBeGreaterThan(0);
    expect(
      findForbiddenTokens('const k = "maths-club";').length
    ).toBeGreaterThan(0);
    expect(
      findForbiddenTokens("type Coupled = { maths_club: string };").length
    ).toBeGreaterThan(0);
    expect(findForbiddenTokens("// a stray note here").length).toBeGreaterThan(
      0
    );
  });
});
