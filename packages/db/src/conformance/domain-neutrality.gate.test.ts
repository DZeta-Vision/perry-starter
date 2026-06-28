/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/db/src/conformance
const DB_SRC = resolve(HERE, ".."); // packages/db/src

// Forbidden domain-coupling tokens. Top-level literals — never built in a loop.
const FORBIDDEN_DOMAIN_TOKENS = [
  /\bgmc\b/i,
  /\bmaths-club\b/i,
  /\bmaths_club\b/i,
  /\bnote\b/i,
] as const;

// Shipped source modules only. Conformance scaffolding (`*.test.ts`) necessarily
// names these tokens in order to detect them, so it is not domain source.
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

// Pure detector — used in both directions (clean source here; planted token in
// the mutation twin).
const findForbiddenTokens = (source: string): string[] => {
  const hits: string[] = [];
  for (const re of FORBIDDEN_DOMAIN_TOKENS) {
    if (re.test(source)) {
      hits.push(re.source);
    }
  }
  return hits;
};

describe("packages/db source is domain-neutral", () => {
  test("no shipped db source module carries a domain-coupling token", () => {
    const hits: string[] = [];
    for (const file of walk(DB_SRC, isShippedSource)) {
      hits.push(...findForbiddenTokens(readFileSync(file, "utf8")));
    }
    expect(hits).toEqual([]);
  });
});
