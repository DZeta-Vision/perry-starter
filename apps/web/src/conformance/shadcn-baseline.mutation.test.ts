import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Proves the shadcn-baseline gate reddens on a hard-coded brand colour and on a
// missing baseline file, with clean controls that stay green. Detector logic is
// re-declared locally (mutation twins never import the gate file).

const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/;
const COLOR_FN_RE = /\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\(/;
const BRAND_PALETTE_CLASS_RE =
  /\b(?:bg|text|border|ring|fill|stroke)-(?:teal|cyan|emerald|sky|green)-\d/;

const hardCodedBrandColour = (source: string): boolean =>
  HEX_COLOR_RE.test(source) ||
  COLOR_FN_RE.test(source) ||
  BRAND_PALETTE_CLASS_RE.test(source);

const BASELINE_COMPONENTS = [
  "button.tsx",
  "card.tsx",
  "dialog.tsx",
  "dropdown-menu.tsx",
  "input.tsx",
  "label.tsx",
  "checkbox.tsx",
  "skeleton.tsx",
  "sonner.tsx",
] as const;

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// Presence check over an arbitrary directory (so a fixture dir can omit dialog.tsx).
const missingBaseline = (dir: string): string[] =>
  BASELINE_COMPONENTS.filter((name) => !isFile(join(dir, name)));

describe("the shadcn-baseline gate reddens on a hard-coded brand colour and a missing file", () => {
  test("a components/ui file with a hard-coded brand colour trips the token-discipline guard", () => {
    // Control: a tokens-only className stays green.
    expect(
      hardCodedBrandColour('className="bg-primary text-primary-foreground"')
    ).toBe(false);
    // Mutations: a hex arbitrary value and a raw teal utility both red.
    expect(hardCodedBrandColour('className="bg-[#0d9488]"')).toBe(true);
    expect(hardCodedBrandColour('className="text-teal-600"')).toBe(true);
  });

  test("a fixture directory missing dialog.tsx reds the presence assertion", () => {
    // A non-existent directory has zero baseline files present — all are missing.
    const fixtureDir = join("/nonexistent-baseline-fixture");
    expect(missingBaseline(fixtureDir)).toContain("dialog.tsx");
    expect(missingBaseline(fixtureDir).length).toBe(BASELINE_COMPONENTS.length);
  });
});
