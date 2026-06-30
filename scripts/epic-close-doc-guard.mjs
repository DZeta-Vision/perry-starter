#!/usr/bin/env node
// Epic-close documentation guard (LOCAL-ONLY by necessity, RUNNABLE NOW).
//
// Story/planning artifacts live under _bmad-output/, which is GITIGNORED. CI
// clones only tracked files (the `git ls-files` reality the other gates rely
// on), so CI can NEVER see these files — this guard cannot be a CI job, and
// pretending otherwise would be the classic "the gate can't see the artifact"
// trap. It is therefore the LOCAL half of the epic-close discipline: run
//   bun run gate:epic-close <epic>
// before marking an epic done. The CI-enforced half is bmad-ref-guard.mjs
// (committed-code hygiene), which scans tracked code and DOES block a merge.
//
// For the named epic, every story file must reflect EXECUTION state, not a
// red-phase scaffold:
//   1. a Status line that reads done/complete,
//   2. a Dev Agent Record / Completion Notes section, and
//   3. NO contradictory status banner (a Status line still reading
//      red/draft/in-progress/blocked) and no hard "NOT YET IMPLEMENTED" lie.
// Prose that merely describes the original ATDD red-phase (e.g. mentioning a
// test.skip scaffold) is fine — only a contradictory STATUS assertion fails.
//
// Dependency-free; uses node:fs only.
//   --epic <n>   (required) the epic number whose stories to check
//   --dir <path> (optional) story directory; defaults to the impl-artifacts dir

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_DIR = join(REPO_ROOT, "_bmad-output", "implementation-artifacts");

// A Status line reading done/complete (at least one required).
const DONE_STATUS =
  /(?:^|\n)[#>*_\s-]*\*{0,2}status\*{0,2}\s*[:=]\s*"?(?:done|complete|completed)\b/i;
// A Status line still asserting an UNfinished state (a contradiction — fails).
const CONTRADICTORY_STATUS =
  /(?:^|\n)[#>*_\s-]*\*{0,2}status\*{0,2}\s*[:=]\s*"?(?:red|draft|in[ -]?progress|blocked|todo|pending|not[ -]?started|ready[ -]?for[ -]?dev)\b/i;
// An execution-record SECTION — anchored at a line start (optionally as a
// markdown heading or bold label) so incidental prose like "no execution
// record" can never satisfy it.
const EXEC_RECORD =
  /(?:^|\n)\s{0,3}(?:#{1,6}\s*)?(?:\*\*\s*)?(?:Dev Agent Record|Completion Notes|Execution Record)\b/i;
// A hard banner that flatly lies about a done story.
const HARD_LIE = /NOT YET IMPLEMENTED|all tests?(?: are)? skipped/i;

const argValue = (flag) => {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? null : process.argv[idx + 1];
};

const main = () => {
  const epic = argValue("--epic");
  if (!epic) {
    process.stderr.write(
      "epic-close-doc-guard: usage: --epic <n> [--dir <path>]\n"
    );
    process.exit(2);
    return;
  }
  const dir = resolve(argValue("--dir") ?? DEFAULT_DIR);

  let entries;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    process.stderr.write(
      `epic-close-doc-guard: cannot read story dir ${dir}: ${error.message}\n`
    );
    process.exit(1);
    return;
  }

  // Story files for this epic: `<epic>-<n>-...md`, excluding the epic summary
  // and the retrospective file.
  const storyRe = new RegExp(`^${epic}-\\d+-.*\\.md$`);
  const stories = entries.filter(
    (name) => storyRe.test(name) && !name.includes("-retro")
  );

  if (stories.length === 0) {
    process.stderr.write(
      `epic-close-doc-guard: no story files for epic ${epic} in ${dir} (vacuous check refused)\n`
    );
    process.exit(1);
    return;
  }

  const problems = [];
  for (const name of stories.sort()) {
    const text = readFileSync(join(dir, name), "utf8");
    const issues = [];
    if (!DONE_STATUS.test(text)) {
      issues.push("no done Status line");
    }
    if (!EXEC_RECORD.test(text)) {
      issues.push("no Dev Agent Record / Completion Notes");
    }
    if (CONTRADICTORY_STATUS.test(text)) {
      issues.push("a contradictory (unfinished) Status banner remains");
    }
    if (HARD_LIE.test(text)) {
      issues.push(
        "a 'NOT YET IMPLEMENTED' / 'all tests skipped' banner remains"
      );
    }
    if (issues.length > 0) {
      problems.push(`  ${name}: ${issues.join("; ")}`);
    }
  }

  process.stdout.write(
    `epic-close-doc-guard: checked ${stories.length} story file(s) for epic ${epic}.\n`
  );

  if (problems.length > 0) {
    process.stderr.write(
      `\nepic-close-doc-guard: FAILED — ${problems.length} story file(s) do not reflect execution state:\n${problems.join(
        "\n"
      )}\n\nWrite back each story (status done + Dev Agent Record, no stale banner) before closing the epic.\n`
    );
    process.exit(1);
    return;
  }

  process.stdout.write(
    `epic-close-doc-guard: PASSED — every epic ${epic} story reflects execution state.\n`
  );
};

main();
