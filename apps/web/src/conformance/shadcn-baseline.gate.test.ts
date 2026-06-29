import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// The shadcn baseline component set is present and inherited AS-IS: re-skinned
// via semantic tokens only (the sole brand-touched surfaces are Button's primary
// variant and the sidebar-active-item). Components are Base-UI-shaped, NOT Radix:
// no @radix-ui import, no forwardRef, no asChild (ref is a plain prop in React 19).

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const UI_DIR = resolve(REPO_ROOT, "apps", "web", "src", "components", "ui");

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

const read = (path: string): string => readFileSync(path, "utf8");

const listUiFiles = (dir: string): string[] => {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
    .map((entry) => join(dir, entry.name));
};

// --- token-discipline: zero hard-coded brand colour -------------------------

const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/;
const COLOR_FN_RE = /\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\(/;
const BRAND_PALETTE_CLASS_RE =
  /\b(?:bg|text|border|ring|fill|stroke)-(?:teal|cyan|emerald|sky|green)-\d/;

const hardCodedBrandColour = (source: string): string[] => {
  const hits: string[] = [];
  if (HEX_COLOR_RE.test(source)) {
    hits.push("hex literal");
  }
  if (COLOR_FN_RE.test(source)) {
    hits.push("rgb/hsl/oklch literal");
  }
  if (BRAND_PALETTE_CLASS_RE.test(source)) {
    hits.push("raw brand-palette utility class");
  }
  return hits;
};

// --- Base-UI shape: NOT Radix (no @radix-ui / forwardRef / asChild) ----------

const RADIX_IMPORT_RE = /@radix-ui\//;
const FORWARD_REF_RE = /\bforwardRef\b/;
const AS_CHILD_RE = /\basChild\b/;

const radixShapeViolations = (source: string): string[] => {
  const hits: string[] = [];
  if (RADIX_IMPORT_RE.test(source)) {
    hits.push("@radix-ui import");
  }
  if (FORWARD_REF_RE.test(source)) {
    hits.push("forwardRef");
  }
  if (AS_CHILD_RE.test(source)) {
    hits.push("asChild");
  }
  return hits;
};

describe("the shadcn baseline is present and inherited AS-IS (tokens-only, Base UI)", () => {
  test("all 9 named baseline components exist under components/ui (incl. dialog.tsx)", () => {
    const missing = BASELINE_COMPONENTS.filter(
      (name) => !isFile(join(UI_DIR, name))
    );
    expect(missing).toEqual([]);
  });

  test("no components/ui/*.tsx hard-codes a brand colour — semantic tokens only", () => {
    const offenders: string[] = [];
    for (const file of listUiFiles(UI_DIR)) {
      if (hardCodedBrandColour(read(file)).length > 0) {
        offenders.push(file.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every components/ui/*.tsx is Base-UI-shaped — no @radix-ui, forwardRef, or asChild", () => {
    const offenders: string[] = [];
    for (const file of listUiFiles(UI_DIR)) {
      if (radixShapeViolations(read(file)).length > 0) {
        offenders.push(file.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
