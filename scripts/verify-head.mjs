#!/usr/bin/env node
// verify:head — the mechanized "is the COMMITTED tree actually green?" step.
//
// Why this exists: several gates in this repo read the git-TRACKED tree (the
// reference guard, the clone/rename template scanners) or the meta structure, so
// a defect can pass a pre-commit run while a file is still untracked and only
// surface once it is committed. The rule is: before declaring a story/epic done
// or opening a PR, re-run the FULL suite on the COMMITTED HEAD — not the working
// copy, not a single package. This script IS that rule, so it stops being a
// remembered habit and becomes a runnable, wireable gate.
//
// It (1) refuses on a dirty working tree — a dirty tree is not HEAD (set
// ALLOW_DIRTY=1 to override on purpose), then runs, in order and all blocking:
// type check, the full Vitest suite, the meta-gate (mutation-twin enforcer), the
// tier-boundary guard, and the reference guard. Any failure exits non-zero.
//
// Dependency-free: node builtins only.

import { execFileSync } from "node:child_process";

const run = (label, cmd, args) => {
  process.stdout.write(`\n▶ ${label}\n`);
  try {
    execFileSync(cmd, args, { stdio: "inherit" });
  } catch {
    process.stderr.write(`\n✗ verify:head failed at: ${label}\n`);
    process.exit(1);
  }
};

const dirty = execFileSync("git", ["status", "--porcelain"]).toString().trim();
if (dirty && !process.env.ALLOW_DIRTY) {
  process.stderr.write(
    "✗ verify:head: the working tree is dirty, so this is NOT the committed HEAD.\n" +
      "  Commit or stash first (this gate verifies the committed state), or set\n" +
      "  ALLOW_DIRTY=1 to run it against the working copy on purpose.\n\n" +
      `${dirty}\n`
  );
  process.exit(1);
}

run("type check (turbo)", "bun", ["run", "check-types"]);
run("full Vitest suite", "bunx", ["vitest", "run"]);
run("meta-gate (mutation-twin enforcer)", "node", ["scripts/meta-gate.mjs"]);
run("tier-boundary guard", "node", [
  "scripts/tier-boundary-guard.mjs",
  "--root",
  ".",
]);
run("reference guard", "node", ["scripts/bmad-ref-guard.mjs"]);

process.stdout.write(
  "\n✓ verify:head: committed HEAD is green (types, full suite, meta-gate, tier-boundary, refs).\n"
);
