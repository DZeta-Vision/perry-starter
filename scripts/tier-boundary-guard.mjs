#!/usr/bin/env node
// Tier-boundary build guard — STRUCTURE (non-blocking today).
//
// It is wired to fail on BOTH bundles:
//   1. concrete-impl-into-UI: an apps/web source importing a concrete
//      *.local.ts / *.cloud.ts seam implementation directly (UI/app/auth code
//      must import only the seam interface, never a concrete implementation).
//   2. denylisted-dep-into-daemon: a denylisted cloud/WASM/prebuilt-JS specifier
//      reachable in the daemon / seam graph (the daemon graph carries no
//      in-process WASM/prebuilt-JS).
//
// Modes:
//   --root <dir>   scan the repo graph; exit 0 when clean.
//   --scan <file>  scan a single file; exit non-zero on any violation.
//
// The daemon-graph scan covers the full text of each source file (every string
// literal), not just import-position specifiers. This closes the non-literal
// dynamic-import gap: a denylisted specifier bound to a variable and then
// dynamic-imported (`const s = "<engine>"; import(s)`) is still caught, because
// the denylisted name appears as a literal in the file. A daemon-graph file has
// no legitimate reason to even name an in-process WASM/prebuilt-JS engine.
//
// Blocking merge-gate enforcement, the full resolved-dependency-closure scan
// across installed transitive deps, and the compile-and-run leg are deferred to
// later hardening; this lands the structural guard plus its self-test.
//
// Dependency-free; uses node:fs only (mirrors scripts/meta-gate.mjs).

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Denylisted cloud/WASM/prebuilt-JS specifiers that must never be reachable in
// the daemon / seam graph (seeded from the build-time seam denylist). `loro-crdt`
// is the npm wrapper the BROWSER tier uses for collaborative editing; it ships /
// instantiates WASM and is foreclosed in the daemon (Loro is browser/sidecar
// only). It is denied here in the daemon graph yet stays legal under apps/web.
const DAEMON_DENYLIST = [
  "@electric-sql/pglite",
  "@surrealdb/wasm",
  "loro-wasm",
  "loro-crdt",
  "@tanstack/ai",
  "@ag-ui/core",
  // Observability SDKs foreclosed in the native binary (the daemon's Sentry path
  // is a hand-rolled HTTP-envelope reporter over native fetch; pino is replaced by
  // structured JSON via stderr). Enforces the "no in-process SDK/WASM/prebuilt-JS
  // in the daemon" law for the exact specifiers observability would reach for.
  "@sentry/node",
  "@sentry/core",
  "@sentry/cloudflare",
  "@sentry/profiling-node",
  "pino",
  "pino-http",
  "pino-pretty",
];

// Directories never worth descending into. `__fixtures__`, `test`, and
// `conformance` hold the guard's own intentionally-bad self-test inputs (planted
// denylisted specifiers, example-bad imports in conformance gates) and must not
// trip the repo scan.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  "coverage",
  ".next",
  ".cache",
  "__fixtures__",
  "test",
  "conformance",
]);

const SOURCE_EXT = /\.[mc]?tsx?$/;
const CONCRETE_IMPL = /\.(?:local|cloud)$/;

// Module-specifier extractors (top-level literals reused via matchAll, which
// does not mutate the source regex).
const FROM_RE = /\bfrom\s*["']([^"']+)["']/g;
const SIDE_EFFECT_RE = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_RE = /\bimport\s*\(\s*["']([^"']+)["']/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']/g;
const SPECIFIER_PATTERNS = [FROM_RE, SIDE_EFFECT_RE, DYNAMIC_RE, REQUIRE_RE];

// UI tier: must import only the seam interface, never a concrete impl.
const UI_ROOTS = ["apps/web/src"];
// Daemon / seam graph: must stay free of denylisted cloud/WASM/prebuilt-JS deps.
const DAEMON_GRAPH_ROOTS = [
  "packages/data/src",
  "packages/ai/src",
  "apps/daemon",
];

const specifiersOf = (text) => {
  const found = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      found.push(match[1]);
    }
  }
  return found;
};

// Every single/double-quoted string literal in the source. The daemon-graph scan
// uses this (a superset of the import-position specifiers) so a denylisted engine
// named anywhere — including a variable later fed to a non-literal `import()` —
// is caught, not just one sitting in a static `from "…"`/`import("…")` position.
const STRING_LITERAL_RE = /["']([^"'\r\n]+)["']/g;
const stringLiteralsOf = (text) => {
  const found = [];
  for (const match of text.matchAll(STRING_LITERAL_RE)) {
    found.push(match[1]);
  }
  return found;
};

const isConcreteImpl = (specifier) =>
  CONCRETE_IMPL.test(specifier.replace(SOURCE_EXT, ""));

const isDenylisted = (specifier) =>
  specifier.endsWith(".wasm") ||
  DAEMON_DENYLIST.some(
    (dep) => specifier === dep || specifier.startsWith(`${dep}/`)
  );

const walk = (dir, out) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // root subtree absent (greenfield) — nothing to scan.
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walk(join(dir, entry.name), out);
      }
    } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
};

const scanRoots = (rootDir, roots, check, label, extract = specifiersOf) => {
  const violations = [];
  for (const root of roots) {
    const files = [];
    walk(resolve(rootDir, root), files);
    for (const file of files) {
      for (const specifier of extract(readFileSync(file, "utf8"))) {
        if (check(specifier)) {
          violations.push(
            `${label}: ${relative(rootDir, file)} imports "${specifier}"`
          );
        }
      }
    }
  }
  return violations;
};

const scanRepo = (rootDir) => [
  ...scanRoots(rootDir, UI_ROOTS, isConcreteImpl, "concrete-impl-into-UI"),
  // The daemon graph is scanned over every string literal (not just import
  // positions) so a denylisted engine reached through a non-literal dynamic
  // import is caught.
  ...scanRoots(
    rootDir,
    DAEMON_GRAPH_ROOTS,
    isDenylisted,
    "denylisted-dep-into-daemon",
    stringLiteralsOf
  ),
];

const scanFile = (file) => {
  const violations = [];
  for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
    if (isConcreteImpl(specifier)) {
      violations.push(`concrete-impl-into-UI: imports "${specifier}"`);
    }
    if (isDenylisted(specifier)) {
      violations.push(`denylisted-dep-into-daemon: imports "${specifier}"`);
    }
  }
  return violations;
};

const valueAfter = (argv, flag) => {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
};

const main = () => {
  const argv = process.argv.slice(2);
  const scanArg = valueAfter(argv, "--scan");
  const rootArg = valueAfter(argv, "--root");

  const violations = scanArg
    ? scanFile(resolve(scanArg))
    : scanRepo(resolve(rootArg ?? process.cwd()));

  if (violations.length === 0) {
    process.stdout.write(
      "tier-boundary guard: PASSED — no tier-boundary violations found.\n"
    );
    return;
  }

  process.stderr.write(
    `tier-boundary guard: FAILED — ${violations.length} violation(s):\n`
  );
  for (const violation of violations) {
    process.stderr.write(`  ${violation}\n`);
  }
  process.exit(1);
};

main();
