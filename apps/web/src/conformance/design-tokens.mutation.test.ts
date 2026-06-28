import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

// Proves the design-token gate genuinely reddens on bad input, with a clean
// control that stays green. Each detector is re-declared locally (mutation twins
// never import the gate file — that would re-register the gate's tests).
//
// The fixture-driven legs point scripts/contrast-gate.mjs at a temp stylesheet
// via the CONTRAST_GATE_CSS environment override.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const CSS_PATH = resolve(REPO_ROOT, "apps", "web", "src", "index.css");
const CONTRAST_GATE = resolve(REPO_ROOT, "scripts", "contrast-gate.mjs");

const read = (path: string): string => readFileSync(path, "utf8");

const WHITESPACE_RE = /\s/;
const TOKEN_DECL_RE = /(--[\w-]+)\s*:\s*([^;]+);/g;
const MULTI_WS_RE = /\s+/g;

const extractBlock = (css: string, selector: string): string | null => {
  let from = 0;
  for (;;) {
    const idx = css.indexOf(selector, from);
    if (idx === -1) {
      return null;
    }
    let cursor = idx + selector.length;
    while (cursor < css.length && WHITESPACE_RE.test(css[cursor] ?? "")) {
      cursor++;
    }
    if (css[cursor] === "{") {
      let depth = 0;
      for (let i = cursor; i < css.length; i++) {
        if (css[i] === "{") {
          depth++;
        } else if (css[i] === "}") {
          depth--;
          if (depth === 0) {
            return css.slice(cursor + 1, i);
          }
        }
      }
      return null;
    }
    from = idx + selector.length;
  }
};

const parseTokens = (block: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const match of block.matchAll(TOKEN_DECL_RE)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      out.set(name, value.replace(MULTI_WS_RE, " ").trim());
    }
  }
  return out;
};

// The two detector predicates the gate relies on.
const hasDarkBlock = (css: string): boolean =>
  extractBlock(css, ".dark") !== null;
const fontSansNamesInter = (css: string): boolean => {
  const theme = parseTokens(extractBlock(css, "@theme inline") ?? "");
  return (theme.get("--font-sans") ?? "").includes('"Inter Variable"');
};

const COMPETING_DECL_RE = /(--primary|--background)\s*:/;
const declaresCompetingToken = (css: string): boolean =>
  COMPETING_DECL_RE.test(css);

const tmpDirs: string[] = [];
const mkFixtureCss = (contents: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "design-tokens-"));
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

describe("the design-token gate reddens on bad input (clean control stays green)", () => {
  test("a fixture reverting light --primary to the pre-AA oklch(0.6 0.1 185) makes the contrast gate exit non-zero", () => {
    const reverted = read(CSS_PATH).replace(
      "--primary: oklch(0.52 0.1 185)",
      "--primary: oklch(0.6 0.1 185)"
    );
    const fixture = mkFixtureCss(reverted);
    const bad = spawnSync("node", [CONTRAST_GATE], {
      encoding: "utf8",
      env: { ...process.env, CONTRAST_GATE_CSS: fixture },
    });
    expect(bad.status).not.toBe(0); // 3.56:1 button / 3.75:1 link — sub-AA
    // Control: the real, AA-fixed token source still passes.
    const control = spawnSync("node", [CONTRAST_GATE], { encoding: "utf8" });
    expect(control.status).toBe(0);
  });

  test("a fixture missing the .dark block, or whose --font-sans no longer names Inter Variable, reds the token-source detector", () => {
    const real = read(CSS_PATH);
    // Control stays green on the real source.
    expect(hasDarkBlock(real)).toBe(true);
    expect(fontSansNamesInter(real)).toBe(true);
    // Mutation 1: strip the .dark block.
    const darkStart = real.indexOf(".dark");
    const noDark = real.slice(0, darkStart);
    expect(hasDarkBlock(noDark)).toBe(false);
    // Mutation 2: swap --font-sans away from Inter Variable.
    const wrongFont = real.replace('"Inter Variable", sans-serif', "system-ui");
    expect(fontSansNamesInter(wrongFont)).toBe(false);
  });

  test("a second competing --primary declaration in another file trips the single-source guard", () => {
    // Clean control: a stylesheet with no token declarations.
    expect(declaresCompetingToken(".sidebar { padding: 1rem; }")).toBe(false);
    // Mutation: a sibling stylesheet re-declares --primary.
    expect(
      declaresCompetingToken(":root { --primary: oklch(0.7 0.2 30); }")
    ).toBe(true);
  });
});
