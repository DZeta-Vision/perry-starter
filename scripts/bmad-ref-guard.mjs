#!/usr/bin/env node
// BMAD-reference guard (RUNNABLE NOW, BLOCKING in CI).
//
// The repo convention: committed code must be BMAD-agnostic. Tracked source,
// tests, and comments must contain NO planning-artifact ids — no architecture
// decision (AD-##), functional/non-functional requirement (FR-##/NFR-##),
// acceptance criterion (AC#), story id (Story #.#), or epic-risk id (E#-R##).
// Those ids point into gitignored planning dirs that may be deleted at any time
// and mean nothing to anyone who just clones the repo.
//
// This guard scans every TRACKED code file (the files an adopter actually
// clones — gitignored planning artifacts under _bmad-output/ never reach it,
// the same `git ls-files` discipline the documents-removal gate uses) for those
// ids and exits non-zero listing each hit. YAML/markdown/JSON are intentionally
// out of scope: this targets code comments, which is where the leak hides even
// when test NAMES are clean.
//
// Dependency-free; uses node:child_process (git ls-files) + node:fs only.
// Pass `--root <dir>` to scan an arbitrary directory tree instead of the tracked
// set (used by the gate test + mutation twin against temp fixtures).

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

// Code files this guard scans (source + tests). Config/docs are out of scope.
const CODE_EXT = /\.(?:[mc]?tsx?|[mc]?jsx?|surql)$/;

// The banned planning-artifact id families. Each must use a word boundary so
// substrings of real identifiers (e.g. the `AC` inside `MAC7`) never match.
const BMAD_PATTERNS = [
  { name: "architecture-decision", re: /\bAD-\d+/ },
  { name: "functional-requirement", re: /\bFR-\d+/ },
  { name: "nonfunctional-requirement", re: /\bNFR-\d+/ },
  { name: "epic-risk-id", re: /\bE\d+-R\d+/ },
  { name: "story-id", re: /\bStory\s+\d+\.\d+/ },
  { name: "acceptance-criterion", re: /\bAC\d+\b/ },
];

// Tests must be named for the behavior they assert, not a BMAD story key. A
// trailing `-<epic>-<story>` segment before the test suffix (e.g.
// `rbac-deny-on-both-legs-2-3.acceptance.test.ts`) is a story-key reference.
// One/two-digit epic+story only, so a date suffix like `-2024-01` never matches.
const STORY_KEY_FILENAME =
  /[-_]\d{1,2}-\d{1,2}\.(?:acceptance\.)?(?:test|spec)\.ts$/i;

// This guard's own tooling necessarily CONTAINS the banned patterns (the regexes
// above, plus the mutation twin's known-bad fixtures). Exempt EXACTLY this
// family and nothing else — the whole product surface (apps/ + packages/ + the
// rest of scripts/) is still scanned.
const SELF_TOOLING = new Set([
  "scripts/bmad-ref-guard.mjs",
  "scripts/bmad-ref-guard.gate.test.ts",
  "scripts/bmad-ref-guard.mutation.test.ts",
]);

// Directories never worth descending into when walking a `--root` fixture tree.
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

// File list: with `--root`, walk that dir (fixtures have no git); otherwise the
// git-tracked set at the repo root.
const collectFiles = (root) => {
  if (root) {
    const out = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            walk(join(dir, entry.name));
          }
        } else if (entry.isFile()) {
          out.push(join(dir, entry.name));
        }
      }
    };
    walk(root);
    return out.map((abs) => ({ abs, rel: abs.slice(root.length + 1) }));
  }
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT })
    .toString()
    .split("\0")
    .filter(Boolean);
  return tracked.map((rel) => ({ abs: join(REPO_ROOT, rel), rel }));
};

const scanFile = (abs) => {
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return [];
  }
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of BMAD_PATTERNS) {
      const match = lines[i].match(pattern.re);
      if (match) {
        hits.push({
          line: i + 1,
          pattern: pattern.name,
          match: match[0],
          text: lines[i].trim().slice(0, 120),
        });
      }
    }
  }
  return hits;
};

const main = () => {
  const rootIdx = process.argv.indexOf("--root");
  const root = rootIdx === -1 ? null : resolve(process.argv[rootIdx + 1]);

  const files = collectFiles(root).filter(
    (file) => CODE_EXT.test(file.rel) && !SELF_TOOLING.has(file.rel)
  );

  const findings = [];
  const filenameFindings = [];
  for (const file of files) {
    for (const hit of scanFile(file.abs)) {
      findings.push({ rel: file.rel, ...hit });
    }
    if (STORY_KEY_FILENAME.test(file.rel)) {
      filenameFindings.push(file.rel);
    }
  }

  process.stdout.write(
    `bmad-ref-guard: scanned ${files.length} tracked code file(s).\n`
  );

  if (files.length === 0) {
    process.stderr.write(
      "bmad-ref-guard: no code files scanned — empty tree (vacuous scan refused)\n"
    );
    process.exit(1);
    return;
  }

  if (findings.length > 0 || filenameFindings.length > 0) {
    if (findings.length > 0) {
      process.stderr.write(
        `\nbmad-ref-guard: FAILED — ${findings.length} BMAD reference(s) in committed code:\n`
      );
      for (const finding of findings) {
        process.stderr.write(
          `  ${finding.rel}:${finding.line}  ${finding.match} (${finding.pattern})  ${finding.text}\n`
        );
      }
      process.stderr.write(
        "\nCommitted code must be BMAD-agnostic. Rewrite the comment to state the\nfact without the planning id (it points into gitignored dirs).\n"
      );
    }
    if (filenameFindings.length > 0) {
      process.stderr.write(
        `\nbmad-ref-guard: FAILED — ${filenameFindings.length} test file(s) named after a BMAD story key:\n`
      );
      for (const rel of filenameFindings) {
        process.stderr.write(`  ${rel}\n`);
      }
      process.stderr.write(
        "\nName tests for the behavior they assert, not a story/AC id — drop the\ntrailing -<epic>-<story> from the filename.\n"
      );
    }
    process.exit(1);
    return;
  }

  process.stdout.write(
    `bmad-ref-guard: PASSED — 0 BMAD references and 0 story-key filenames across ${files.length} committed code file(s).\n`
  );
};

main();
