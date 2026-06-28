import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Inter Variable must be loaded as a first-class asset so swapping --font-sans
// swaps the LOADED asset, never a silent system-sans fallback. The asset is
// loaded at the apps/web client entry; the loaded family must agree with the
// --font-sans token, and @fontsource-variable/inter must be a declared dependency.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const WEB = resolve(REPO_ROOT, "apps", "web");
const WEB_SRC = resolve(WEB, "src");
const ROUTER = resolve(WEB_SRC, "router.tsx");
const INDEX_CSS = resolve(WEB_SRC, "index.css");
const ROOT_TSX = resolve(WEB_SRC, "routes", "__root.tsx");
const WEB_PKG = resolve(WEB, "package.json");

const read = (path: string): string => readFileSync(path, "utf8");
const readOrEmpty = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

const MULTI_WS_RE = /\s+/g;
const TOKEN_DECL_RE = /(--[\w-]+)\s*:\s*([^;]+);/g;
const WHITESPACE_RE = /\s/;

// At least one of: a JS import of the fontsource package in the client entry,
// an @import of it in index.css, or an explicit @font-face / <link> for the
// "Inter Variable" family anywhere in apps/web.
const FONTSOURCE_IMPORT_RE =
  /(?:import\s+["']|@import\s+["'])@fontsource-variable\/inter(?:\/[\w.-]+)?["']/;
const FONT_FACE_INTER_RE =
  /@font-face[\s\S]*?font-family\s*:\s*["']Inter Variable["']/i;
const LINK_INTER_RE = /<link[^>]+Inter[ +]Variable[^>]*>/i;

const loadsInterAsset = (sources: string[]): boolean =>
  sources.some(
    (src) =>
      FONTSOURCE_IMPORT_RE.test(src) ||
      FONT_FACE_INTER_RE.test(src) ||
      LINK_INTER_RE.test(src)
  );

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

// The primary family named by --font-sans, unquoted (e.g. `Inter Variable`).
const PRIMARY_FAMILY_RE = /^["']?([^"',]+)["']?/;
const fontSansPrimaryFamily = (css: string): string => {
  const block = extractBlock(css, "@theme inline") ?? "";
  for (const match of block.matchAll(TOKEN_DECL_RE)) {
    if (match[1] === "--font-sans") {
      const value = (match[2] ?? "").replace(MULTI_WS_RE, " ").trim();
      const family = value.match(PRIMARY_FAMILY_RE);
      return (family?.[1] ?? "").trim();
    }
  }
  return "";
};

describe("Inter Variable is loaded as a first-class asset, agreeing with --font-sans", () => {
  test("the apps/web entry loads the Inter Variable webfont as a real asset", () => {
    const sources = [read(ROUTER), read(INDEX_CSS), readOrEmpty(ROOT_TSX)];
    expect(loadsInterAsset(sources)).toBe(true);
  });

  test("the loaded family name matches the --font-sans token (no orphan token)", () => {
    expect(fontSansPrimaryFamily(read(INDEX_CSS))).toBe("Inter Variable");
  });

  test("@fontsource-variable/inter is declared in apps/web dependencies (the asset source)", () => {
    const pkg = JSON.parse(read(WEB_PKG)) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["@fontsource-variable/inter"]).toBeDefined();
  });
});
