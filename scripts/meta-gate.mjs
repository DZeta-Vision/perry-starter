#!/usr/bin/env node
// Meta-gate — the anti-vacuous enforcer (RUNNABLE NOW, BLOCKING).
//
// Gate vacuousness: a conformance gate that
// cannot fail ships a false guarantee to every downstream adopter. The
// structural defense is: every conformance-gate test
// (`*.gate.test.ts`) MUST ship a paired mutation twin (`*.mutation.test.ts`)
// that feeds known-bad input and asserts the gate goes red. A gate WITHOUT its
// mutation twin is itself a CI failure.
//
// This script scans `packages/**`, `apps/web/**`, and `apps/daemon/**` for
// `*.gate.test.ts`; for each, it asserts a sibling `*.mutation.test.ts` exists.
// It exits non-zero listing any gate missing its twin.
//
// Today there are zero gate files (the `packages/*` they live in do not exist
// yet). The structure is wired and ready: with no gates the
// invariant "every gate has a twin" is vacuously TRUE, so the gate exits 0
// cleanly and reports that the structure is ready. Once real gate files land,
// this becomes a live blocking enforcer with nothing further to wire.
//
// Dependency-free; uses node:fs only.

import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

// Roots to scan for conformance-gate test files.
const SCAN_ROOTS = ["packages", join("apps", "web"), join("apps", "daemon")];

// Directories never worth descending into.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  "coverage",
  ".next",
  ".cache",
]);

const GATE_SUFFIX = ".gate.test.ts";
const MUTATION_SUFFIX = ".mutation.test.ts";

// Recursively collect every file path under `dir` that ends with `suffix`.
const collectBySuffix = (dir, suffix, out) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Root or subtree does not exist yet (greenfield) — nothing to collect.
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      collectBySuffix(join(dir, entry.name), suffix, out);
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      out.push(join(dir, entry.name));
    }
  }
};

// The mutation twin for `foo.gate.test.ts` is `foo.mutation.test.ts` in the
// SAME directory.
const expectedTwin = (gatePath) =>
  gatePath.slice(0, -GATE_SUFFIX.length) + MUTATION_SUFFIX;

const fileExists = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const main = () => {
  const gateFiles = [];
  for (const root of SCAN_ROOTS) {
    collectBySuffix(resolve(REPO_ROOT, root), GATE_SUFFIX, gateFiles);
  }

  if (gateFiles.length === 0) {
    process.stdout.write(
      "0 conformance gates found; meta-gate satisfied (structure ready)\n"
    );
    return;
  }

  const orphans = [];
  for (const gatePath of gateFiles) {
    if (!fileExists(expectedTwin(gatePath))) {
      orphans.push(gatePath);
    }
  }

  const relative = (path) => path.slice(REPO_ROOT.length + 1);

  process.stdout.write(
    `meta-gate: scanned ${gateFiles.length} conformance gate file(s).\n`
  );

  if (orphans.length > 0) {
    process.stderr.write(
      `\nmeta-gate: FAILED — ${orphans.length} gate(s) missing a mutation twin (${MUTATION_SUFFIX}):\n`
    );
    for (const gatePath of orphans) {
      process.stderr.write(
        `  ${relative(gatePath)}  ->  expected ${relative(expectedTwin(gatePath))}\n`
      );
    }
    process.stderr.write(
      "\nEvery conformance gate must ship a mutation twin or CI fails.\n"
    );
    process.exit(1);
    return;
  }

  process.stdout.write(
    "meta-gate: PASSED — every conformance gate ships a mutation twin.\n"
  );
};

main();
