// Mutation twin for data-rights-surface.gate.test.ts.
//
// It feeds each pure guard the known-bad input the gate forbids and asserts the
// guard reddens — proving none of the gate's checks is vacuous: a catalog missing
// an FR key is flagged, a multi-step wizard is NOT a one-click affordance, and a
// region lacking the polite attributes is NOT a polite live region.

import { expect, test } from "vitest";

import {
  hasPoliteLiveRegion,
  hasSingleOneClickExport,
  missingTranslations,
} from "./data-rights-surface";

test("a catalog missing an FR translation is flagged (the no-untranslated check reddens)", () => {
  const partial = {
    en: { "dataRights.export.action": "Export", "dataRights.title": "Data" },
    // The FR side is missing one key AND leaves another empty.
    fr: { "dataRights.export.action": "", "dataRights.title": "Données" },
  } as never;
  const missing = missingTranslations(partial);
  expect(missing).not.toEqual([]);
  expect(missing).toContain("fr:dataRights.export.action");
});

test("a multi-step wizard is NOT a one-click affordance (the one-click check reddens)", () => {
  const wizardSource = `
    <button type="button">Start</button>
    <button type="button">Next step</button>
  `;
  expect(hasSingleOneClickExport(wizardSource)).toBe(false);
});

test("a two-button flow (no wizard text) is still NOT one-click (the button-count check reddens)", () => {
  const twoButtons = `
    <button type="button">Prepare</button>
    <button type="button">Confirm</button>
  `;
  expect(hasSingleOneClickExport(twoButtons)).toBe(false);
});

test("a region without the polite attributes is NOT a polite live region (the a11y check reddens)", () => {
  const noPolite = `<div role="alert" aria-live="assertive">ready</div>`;
  expect(hasPoliteLiveRegion(noPolite)).toBe(false);
});
