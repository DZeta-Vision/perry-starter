import { describe, expect, test } from "vitest";

// Proves the font-asset detector reddens on the silent-system-sans-fallback
// conditions, with clean controls that stay green. Detector logic is re-declared
// locally (mutation twins never import the gate file).

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

// A --font-sans whose primary family has no matching loaded asset is an orphan.
const PRIMARY_FAMILY_RE = /--font-sans\s*:\s*["']?([^"',;]+)["']?/;
const fontSansPrimaryFamily = (css: string): string =>
  (css.match(PRIMARY_FAMILY_RE)?.[1] ?? "").trim();

const familyHasLoadedAsset = (family: string, sources: string[]): boolean => {
  if (family === "Inter Variable") {
    return loadsInterAsset(sources);
  }
  // No loaded asset is wired for any other family in this template.
  return false;
};

describe("the font-asset gate reddens when the asset is absent or the token is orphaned", () => {
  test("an entry with the font import / @font-face / <link> removed reds the gate", () => {
    // Control: a client entry that imports the fontsource package passes.
    const withImport = [
      'import "@fontsource-variable/inter";',
      "import './index.css';",
    ];
    expect(loadsInterAsset(withImport)).toBe(true);
    // Mutation: the font load is removed — the token names a family no asset provides.
    const withoutImport = [
      "import './index.css';",
      "import Loader from './loader';",
    ];
    expect(loadsInterAsset(withoutImport)).toBe(false);
  });

  test("a --font-sans swapped to a family with no loaded asset is caught, not silently tolerated", () => {
    const sources = ['import "@fontsource-variable/inter";'];
    // Control: Inter Variable token agrees with the loaded asset.
    const ok = fontSansPrimaryFamily(
      '@theme inline { --font-sans: "Inter Variable", sans-serif; }'
    );
    expect(familyHasLoadedAsset(ok, sources)).toBe(true);
    // Mutation: token swapped to a family with no loaded asset.
    const orphan = fontSansPrimaryFamily(
      '@theme inline { --font-sans: "Roboto Flex", sans-serif; }'
    );
    expect(familyHasLoadedAsset(orphan, sources)).toBe(false);
  });
});
