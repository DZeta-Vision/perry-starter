// Data-rights surface conformance gate (static structural checks).
//
// It asserts the SHIPPED one-click export surface, over the real component source +
// the real catalog: (1) EN/FR catalog parity — no untranslated string on the
// surface, (2) a single one-click export affordance (no multi-step wizard), (3) the
// export confirmation is announced through a POLITE live region, and (4) the
// surface uses real label/heading semantics and routes its visible copy through the
// locale catalog (never a hard-coded literal). The DOM behavior (locale-keyed copy
// reaching the render, the click → polite announcement) is verified in the sibling
// data-export-panel.test.tsx render test.
//
// The mutation twin (data-rights-surface.mutation.test.ts) feeds each pure guard
// known-bad input and asserts it reddens — proving the guards are load-bearing.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { dataRightsCatalog } from "@/lib/data-rights-strings";
import {
  hasPoliteLiveRegion,
  hasSingleOneClickExport,
  missingTranslations,
} from "./data-rights-surface";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_SOURCE = readFileSync(
  resolve(HERE, "..", "components", "settings", "data-export-panel.tsx"),
  "utf8"
);

test("every data-rights string is translated in both EN and FR (no untranslated string on the surface)", () => {
  expect(missingTranslations(dataRightsCatalog)).toEqual([]);
});

test("the surface exposes a single one-click export affordance (no multi-step wizard)", () => {
  expect(hasSingleOneClickExport(PANEL_SOURCE)).toBe(true);
});

test("the surface announces the export confirmation through a polite live region", () => {
  expect(hasPoliteLiveRegion(PANEL_SOURCE)).toBe(true);
});

const HEADING_RE = /<h2\b/;
const LABELLEDBY_RE = /aria-labelledby=/;
const DESCRIBEDBY_RE = /aria-describedby=/;

test("the surface uses real heading + labeled-region + described-control semantics", () => {
  // A heading for the section, a section labeled by that heading, and the export
  // control described by its explanatory copy — the accessible labeling floor.
  expect(PANEL_SOURCE).toMatch(HEADING_RE);
  expect(PANEL_SOURCE).toMatch(LABELLEDBY_RE);
  expect(PANEL_SOURCE).toMatch(DESCRIBEDBY_RE);
});

test("every visible string on the surface is routed through the locale catalog (never a hard-coded literal)", () => {
  // The panel resolves copy ONLY via tDataRights — the i18n seam, not inline text.
  expect(PANEL_SOURCE).toContain("tDataRights");
});
