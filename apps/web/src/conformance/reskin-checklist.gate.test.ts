import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// The adopter re-skin surface is documented as the ~9-teal-derived-token /
// 4-item checklist in apps/web/README.md, and the contrast gate covers the full
// required matrix including the sidebar pairs in both themes — so any --primary
// or sidebar-token change is re-measured on every PR.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const WEB_SRC = resolve(REPO_ROOT, "apps", "web", "src");
const README = resolve(REPO_ROOT, "apps", "web", "README.md");
const INDEX_CSS = resolve(WEB_SRC, "index.css");
const CONTRAST_GATE = resolve(REPO_ROOT, "scripts", "contrast-gate.mjs");

const read = (path: string): string => readFileSync(path, "utf8");

// The 4-item / ~9-token re-skin surface:
//   (1) --primary (:root + .dark); (2) --primary-foreground (.dark);
//   (3) --chart-1..5 (both themes); (4) --sidebar-primary + -foreground (both).
const REQUIRED_CHECKLIST_TOKENS = [
  "--primary",
  "--primary-foreground",
  "--chart-1",
  "--chart-5",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
] as const;

const RESKIN_HEADING_RE = /re-?skin/i;
const TOKEN_MENTION_RE = /--[\w-]+/g;
const ALL_TOKENS_RE = /(--[\w-]+)\s*:/g;
const EVALUATED_COUNT_RE = /PASSED\s*[—-]\s*(\d+)\s*pair/;
// The teal active-item ↔ sidebar surface must be measured in BOTH themes.
const LIGHT_SIDEBAR_PAIR_RE = /\[light\][^\n]*sidebar-primary[^\n]*sidebar/;
const DARK_SIDEBAR_PAIR_RE = /\[dark\][^\n]*sidebar-primary[^\n]*sidebar/;

// Tokens index.css actually defines (across :root, .dark, @theme inline).
const definedTokens = (css: string): Set<string> => {
  const out = new Set<string>();
  for (const match of css.matchAll(ALL_TOKENS_RE)) {
    if (match[1] !== undefined) {
      out.add(match[1]);
    }
  }
  return out;
};

const missingItems = (doc: string): string[] =>
  REQUIRED_CHECKLIST_TOKENS.filter((token) => !doc.includes(token));

// Every --token the doc names must actually exist in index.css (no doc↔code drift).
const driftedTokens = (doc: string, defined: Set<string>): string[] => {
  const drifted: string[] = [];
  for (const match of doc.matchAll(TOKEN_MENTION_RE)) {
    const token = match[0];
    if (!defined.has(token)) {
      drifted.push(token);
    }
  }
  return drifted;
};

describe("the adopter re-skin checklist is documented and free of doc↔code drift", () => {
  test("apps/web/README.md has a Re-skin section naming all four re-skin items", () => {
    const doc = read(README);
    expect(RESKIN_HEADING_RE.test(doc)).toBe(true);
    expect(missingItems(doc)).toEqual([]);
  });

  test("every token the checklist names actually exists in index.css", () => {
    const doc = read(README);
    expect(driftedTokens(doc, definedTokens(read(INDEX_CSS)))).toEqual([]);
  });

  test("the contrast gate covers the sidebar matrix in both themes and passes", () => {
    const result = spawnSync("node", [CONTRAST_GATE], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const out = result.stdout;
    expect(out).toMatch(LIGHT_SIDEBAR_PAIR_RE);
    expect(out).toMatch(DARK_SIDEBAR_PAIR_RE);
    const evaluated = Number(out.match(EVALUATED_COUNT_RE)?.[1] ?? "0");
    expect(evaluated).toBeGreaterThanOrEqual(8);
  });
});
