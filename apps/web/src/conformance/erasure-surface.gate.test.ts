// GDPR erasure surface conformance gate (static structural checks).
//
// It asserts the SHIPPED erasure panel, over the real component source + the real
// catalog: (1) EN/FR catalog parity — no untranslated string on the surface, (2) a
// destructive-confirm dialog gates the action, (3) a per-action step-up re-auth is
// sequenced after the confirm, (4) the abort path wires NO session-killing effect
// (cancel aborts only the action), (5) the erasure confirmation rides a POLITE live
// region, and (6) visible copy is routed through the locale catalog. The DOM behavior
// (single-modal sequencing, cancel-aborts-only, polite announcement) is verified in
// the sibling data-erasure-panel.test.tsx render test; modal DEPTH is enforced by the
// modal-depth gate.
//
// The mutation twin (erasure-surface.mutation.test.ts) feeds each pure guard
// known-bad input and asserts it reddens — proving the guards are load-bearing.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { dataRightsCatalog } from "@/lib/data-rights-strings";
import { missingTranslations } from "./data-rights-surface";
import {
  abortNeverKillsSession,
  hasDestructiveConfirmDialog,
  hasPoliteLiveRegion,
  routesCopyThroughCatalog,
  sequencesStepUp,
} from "./erasure-surface";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_SOURCE = readFileSync(
  resolve(HERE, "..", "components", "settings", "data-erasure-panel.tsx"),
  "utf8"
);

test("every data-rights string is translated in both EN and FR (no untranslated string on the surface)", () => {
  expect(missingTranslations(dataRightsCatalog)).toEqual([]);
});

test("the erasure action is gated behind a destructive-confirm dialog", () => {
  expect(hasDestructiveConfirmDialog(PANEL_SOURCE)).toBe(true);
});

test("a per-action step-up re-auth is sequenced after the confirm", () => {
  expect(sequencesStepUp(PANEL_SOURCE)).toBe(true);
});

test("cancelling aborts only the action — the surface wires no session-killing effect", () => {
  expect(abortNeverKillsSession(PANEL_SOURCE)).toBe(true);
});

test("the surface announces the erasure through a polite live region", () => {
  expect(hasPoliteLiveRegion(PANEL_SOURCE)).toBe(true);
});

test("every visible string on the surface is routed through the locale catalog", () => {
  expect(routesCopyThroughCatalog(PANEL_SOURCE)).toBe(true);
});
