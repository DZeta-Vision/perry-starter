import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

// Proves the re-skin-checklist gate reddens on a doc missing an item or naming an
// absent token, and that the contrast gate reddens when --sidebar-primary is
// lightened below the 4.5:1 floor on the --sidebar surface — with clean controls
// that stay green. Detector logic is re-declared locally.
//
// The contrast-gate fixture leg points scripts/contrast-gate.mjs at a temp
// stylesheet via the CONTRAST_GATE_CSS environment override.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const INDEX_CSS = resolve(REPO_ROOT, "apps", "web", "src", "index.css");
const CONTRAST_GATE = resolve(REPO_ROOT, "scripts", "contrast-gate.mjs");

const read = (path: string): string => readFileSync(path, "utf8");

const REQUIRED_CHECKLIST_TOKENS = [
  "--primary",
  "--primary-foreground",
  "--chart-1",
  "--chart-5",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
] as const;

const TOKEN_MENTION_RE = /--[\w-]+/g;
const ALL_TOKENS_RE = /(--[\w-]+)\s*:/g;

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

const driftedTokens = (doc: string, defined: Set<string>): string[] => {
  const drifted: string[] = [];
  for (const match of doc.matchAll(TOKEN_MENTION_RE)) {
    if (!defined.has(match[0])) {
      drifted.push(match[0]);
    }
  }
  return drifted;
};

const COMPLETE_DOC = `# Re-skin
Change --primary, --primary-foreground, --chart-1 … --chart-5,
--sidebar-primary and --sidebar-primary-foreground, then re-run the gate.`;

const tmpDirs: string[] = [];
const mkFixtureCss = (contents: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "reskin-"));
  tmpDirs.push(dir);
  const file = join(dir, "index.css");
  writeFileSync(file, contents);
  return file;
};

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the re-skin-checklist gate reddens on a missing item, a drifted token, and a sub-AA sidebar pair", () => {
  test("a checklist missing an item, or naming a token absent from index.css, reds the gate", () => {
    const defined = definedTokens(read(INDEX_CSS));
    // Control: a complete, drift-free doc passes both detectors.
    expect(missingItems(COMPLETE_DOC)).toEqual([]);
    expect(driftedTokens(COMPLETE_DOC, defined)).toEqual([]);
    // Mutation 1: drop --sidebar-primary-foreground from the checklist.
    const missingItem = COMPLETE_DOC.replace(
      "and --sidebar-primary-foreground",
      "(done)"
    );
    expect(missingItems(missingItem)).toContain("--sidebar-primary-foreground");
    // Mutation 2: name a token that does not exist in index.css.
    const drifted = `${COMPLETE_DOC}\nAlso tweak --brand-accent.`;
    expect(driftedTokens(drifted, defined)).toContain("--brand-accent");
  });

  test("a fixture lightening --sidebar-primary below the 4.5:1 floor makes the contrast gate exit non-zero", () => {
    // Lighten the light-theme --sidebar-primary toward the --sidebar surface so
    // the teal-active-item ↔ sidebar pair drops below AA.
    const lightened = read(INDEX_CSS).replace(
      "--sidebar-primary: oklch(0.52 0.1 185)",
      "--sidebar-primary: oklch(0.92 0.05 185)"
    );
    const fixture = mkFixtureCss(lightened);
    const bad = spawnSync("node", [CONTRAST_GATE], {
      encoding: "utf8",
      env: { ...process.env, CONTRAST_GATE_CSS: fixture },
    });
    expect(bad.status).not.toBe(0);
    // Control: the real, AA-fixed token source still passes the extended gate.
    const control = spawnSync("node", [CONTRAST_GATE], { encoding: "utf8" });
    expect(control.status).toBe(0);
  });
});
