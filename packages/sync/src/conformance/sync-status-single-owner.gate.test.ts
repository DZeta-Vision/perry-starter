// Conformance gate — the sync verdict has a single owner; the UI is a pure
// renderer that never re-derives it.
//
// Two guarantees, enforced by scanning the real source tree:
//   1. The verdict predicate / seam-derive is referenced ONLY in the sync seam
//      tier (and the db single-source home) — never in another package tier and
//      never in an app. No second site computes the verdict.
//   2. The UI tier (apps/web/src) imports neither the predicate/seam-derive nor
//      the raw cursor fields the verdict is derived from — it sees only the
//      opaque `SyncStatus` verdict.
//
// Its paired mutation twin proves the detector fires on a second computing site
// and on a UI that re-derives from raw cursors, and does NOT false-positive on a
// UI that only renders the verdict.
//
// RED PHASE: every test is skipped until the seam is implemented.

import type { Dirent } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { describe, expect, test } from "vitest";

// The verdict-producing symbols. Referencing either is "computing the verdict".
const COMPUTE_SYMBOLS = ["computeSyncStatus", "deriveItemSyncStatus"];

// The raw integer-cursor fields the verdict is derived from. The UI must never
// touch these — it renders the opaque verdict, not the cursors.
const RAW_CURSOR_FIELDS = [
  "updated_cursor",
  "acked_cursor",
  "latest_known_server_cursor",
  "projection_cursor",
];

// The only tiers permitted to compute the verdict: the sync seam (the owner)
// and the db single-source home (architecture-sanctioned).
const COMPUTE_HOMES = [
  join("packages", "sync", "src"),
  join("packages", "db", "src"),
];

const isTestFile = (name: string) =>
  name.endsWith(".test.ts") || name.endsWith(".test.tsx");

const collectSourceFiles = (dir: string): string[] => {
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
      out.push(...collectSourceFiles(full));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !(isTestFile(entry.name) || entry.name.endsWith(".gen.ts"))
    ) {
      out.push(full);
    }
  }
  return out;
};

const referencesAny = (source: string, needles: readonly string[]): boolean =>
  needles.some((needle) => source.includes(needle));

const repoRoot = () => resolve(process.cwd());

const underAnyHome = (file: string, root: string): boolean =>
  COMPUTE_HOMES.some((home) => file.startsWith(join(root, home) + sep));

describe("the sync verdict is computed in exactly one place", () => {
  test("the verdict predicate and seam-derive are referenced only in the sync seam tier", () => {
    const root = repoRoot();
    const scanned = [join(root, "packages"), join(root, "apps")].flatMap(
      (dir) => collectSourceFiles(dir)
    );

    const offenders = scanned.filter(
      (file) =>
        referencesAny(readFileSync(file, "utf8"), COMPUTE_SYMBOLS) &&
        !underAnyHome(file, root)
    );
    expect(offenders).toEqual([]);

    // Anti-vacuous: the guarantee is not vacuously true — the seam home really
    // does own the verdict.
    const owners = scanned.filter(
      (file) =>
        referencesAny(readFileSync(file, "utf8"), COMPUTE_SYMBOLS) &&
        underAnyHome(file, root)
    );
    expect(owners.length).toBeGreaterThan(0);
  });
});

describe("the UI renders the verdict and never re-derives it", () => {
  test("no UI file imports the verdict predicate or the seam-derive", () => {
    const uiDir = join(repoRoot(), "apps", "web", "src");
    const offenders = collectSourceFiles(uiDir).filter((file) =>
      referencesAny(readFileSync(file, "utf8"), COMPUTE_SYMBOLS)
    );
    expect(offenders).toEqual([]);
  });

  test("no UI file references the raw cursor fields the verdict is derived from", () => {
    const uiDir = join(repoRoot(), "apps", "web", "src");
    const offenders = collectSourceFiles(uiDir).filter((file) =>
      referencesAny(readFileSync(file, "utf8"), RAW_CURSOR_FIELDS)
    );
    expect(offenders).toEqual([]);
  });
});
