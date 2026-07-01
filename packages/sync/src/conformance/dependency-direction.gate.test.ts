// Conformance gate — acyclic dependency direction.
//
// The contract: sync -> api -> auth -> db. The seam package depends on api
// contracts and the db shapes; NOTHING in api/auth/db may import this package
// back (that would be a cycle and would invert the single-source direction).
// This gate scans the upstream source trees and asserts none of them import
// `@perry-starter/sync`, and that this package imports only allowed specifiers.
// Its paired mutation twin proves the detector actually fires on a reverse
// import.
//
// The sync module surface is implemented, so this gate is active.

import type { Dirent } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

// Match only real `import … from "x"` / `export … from "x"` statements (anchored
// at the start of a line, and not crossing a statement terminator), so the words
// "import"/"export" appearing inside a comment or a string literal are never
// mistaken for a dependency edge.
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
const SYNC_PACKAGE = "@perry-starter/sync";

// The specifiers this package is permitted to import: the canonical db shapes,
// the api contracts (the allowed downward edges), relative paths, node
// builtins, and the test runner.
const ALLOWED_PREFIXES = [
  "@perry-starter/db",
  "@perry-starter/api",
  "node:",
  "vitest",
  "./",
  "../",
];

const importedSpecifiers = (source: string): string[] => {
  const out: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1];
    if (specifier) {
      out.push(specifier);
    }
  }
  return out;
};

const collectTsFiles = (dir: string): string[] => {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
};

const repoRoot = () => resolve(process.cwd());

describe("dependency direction is acyclic (sync -> api -> ... -> db)", () => {
  test("no upstream package imports @perry-starter/sync", () => {
    const upstream = ["api", "auth", "db"].map((p) =>
      join(repoRoot(), "packages", p, "src")
    );
    for (const dir of upstream) {
      for (const file of collectTsFiles(dir)) {
        const specifiers = importedSpecifiers(readFileSync(file, "utf8"));
        expect(specifiers).not.toContain(SYNC_PACKAGE);
      }
    }
  });

  test("this package imports only allowed downstream specifiers", () => {
    const syncSrc = join(repoRoot(), "packages", "sync", "src");
    for (const file of collectTsFiles(syncSrc)) {
      const specifiers = importedSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        expect(
          ALLOWED_PREFIXES.some((prefix) => specifier.startsWith(prefix))
        ).toBe(true);
      }
    }
  });
});
