import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// apps/web/src/index.css is the single normative front-end token source: full
// light+dark token sets, the AA-fixed brand constants, --radius, the Inter
// --font-sans, and NO competing token block anywhere else under apps/web/src.
//
// The contrast-obligation leg runs scripts/contrast-gate.mjs and asserts it is
// wired BLOCKING in CI.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const WEB_SRC = resolve(REPO_ROOT, "apps", "web", "src");
const CSS_PATH = resolve(WEB_SRC, "index.css");
const CONTRAST_GATE = resolve(REPO_ROOT, "scripts", "contrast-gate.mjs");
const CI_WORKFLOW = resolve(REPO_ROOT, ".github", "workflows", "ci.yml");
const ROOT_PKG = resolve(REPO_ROOT, "package.json");

const read = (path: string): string => readFileSync(path, "utf8");

// --- CSS block + token parsing (mirrors scripts/contrast-gate.mjs) ----------

const WHITESPACE_RE = /\s/;
const TOKEN_DECL_RE = /(--[\w-]+)\s*:\s*([^;]+);/g;
const MULTI_WS_RE = /\s+/g;

// Find `selector` immediately heading a `{ … }` block and return its inner text.
// Plain indexOf is wrong: `.dark` also appears inside the @custom-variant rule.
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

// The full token set both :root (light) and .dark MUST define. --radius is
// root-only and --font-sans lives in @theme inline; both are asserted separately.
const REQUIRED_THEME_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--border",
  "--input",
  "--ring",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--sidebar-ring",
] as const;

const missingTokens = (tokens: Map<string, string>): string[] =>
  REQUIRED_THEME_TOKENS.filter((name) => !tokens.has(name));

// --- single-source guard: index.css is the SOLE token source ----------------

const COMPETING_DECL_RE = /(--primary|--background)\s*:/;
const ROOT_BLOCK_RE = /:root\s*\{/;
const DARK_BLOCK_RE = /(^|[^\w-])\.dark\s*\{/;

const collectCss = (dir: string, out: string[]): void => {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        collectCss(full, out);
      }
    } else if (entry.isFile() && entry.name.endsWith(".css")) {
      out.push(full);
    }
  }
};

// Any .css under apps/web/src OTHER THAN index.css that declares a :root/.dark
// token block or a competing --primary/--background is a single-source breach.
const findCompetingTokenSources = (): string[] => {
  const files: string[] = [];
  collectCss(WEB_SRC, files);
  const offenders: string[] = [];
  for (const file of files) {
    if (file === CSS_PATH) {
      continue;
    }
    const css = read(file);
    if (
      ROOT_BLOCK_RE.test(css) ||
      DARK_BLOCK_RE.test(css) ||
      COMPETING_DECL_RE.test(css)
    ) {
      offenders.push(file.slice(REPO_ROOT.length + 1));
    }
  }
  return offenders;
};

// --- CI-wiring helper: the contrast step must be BLOCKING -------------------

// Split the workflow into `- name:`-headed step blocks and return the block
// that runs the contrast gate (so we can assert it carries no continue-on-error).
const STEP_SPLIT_RE = /^\s*- name:/m;
const contrastStepBlock = (workflow: string): string | null => {
  const steps = workflow.split(STEP_SPLIT_RE);
  for (const step of steps) {
    if (step.includes("contrast-gate.mjs") || step.includes("gate:contrast")) {
      return step;
    }
  }
  return null;
};

describe("index.css is the single normative front-end design-token source", () => {
  test("both :root (light) and .dark define the full required token set", () => {
    const css = read(CSS_PATH);
    const light = extractBlock(css, ":root");
    const dark = extractBlock(css, ".dark");
    expect(light).not.toBeNull();
    expect(dark).not.toBeNull();
    expect(missingTokens(parseTokens(light ?? ""))).toEqual([]);
    expect(missingTokens(parseTokens(dark ?? ""))).toEqual([]);
  });

  test("the brand layer equals the shipped AA-fixed constants and names Inter Variable", () => {
    const css = read(CSS_PATH);
    const light = parseTokens(extractBlock(css, ":root") ?? "");
    // AA-fixed brand constants — these values are normative; do NOT re-author them.
    expect(light.get("--primary")).toBe("oklch(0.52 0.1 185)");
    expect(light.get("--ring")).toBe("oklch(0.64 0 0)");
    expect(light.get("--radius")).toBe("0.625rem");
    // --font-sans is declared in @theme inline and names the Inter Variable family.
    const theme = parseTokens(extractBlock(css, "@theme inline") ?? "");
    const fontSans = theme.get("--font-sans") ?? "";
    expect(fontSans).toContain('"Inter Variable"');
  });

  test("no other apps/web/src file declares a competing token block — index.css is the sole source", () => {
    expect(findCompetingTokenSources()).toEqual([]);
  });

  test("the WCAG-AA contrast gate passes and is wired BLOCKING in CI", () => {
    const result = spawnSync("node", [CONTRAST_GATE], { encoding: "utf8" });
    expect(result.status).toBe(0);
    // The contrast obligation is enforced on every PR.
    const pkg = read(ROOT_PKG);
    expect(pkg).toContain("contrast-gate.mjs");
    const workflow = read(CI_WORKFLOW);
    const step = contrastStepBlock(workflow);
    expect(step).not.toBeNull();
    expect(step).not.toContain("continue-on-error: true");
  });
});
