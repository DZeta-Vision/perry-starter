// Mutation twin for the erasure surface gate — proves each pure guard is
// load-bearing by feeding it known-bad input and asserting it reddens, with the real
// panel source as the green control.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

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

test("a surface with no destructive-confirm dialog reddens the confirm guard", () => {
  // A bare button with no Dialog / destructive variant / confirm CTA.
  expect(
    hasDestructiveConfirmDialog("<button onClick={erase}>Erase</button>")
  ).toBe(false);
  // Green control: the real panel gates behind a destructive-confirm dialog.
  expect(hasDestructiveConfirmDialog(PANEL_SOURCE)).toBe(true);
});

test("a surface that never renders the step-up modal reddens the sequencing guard", () => {
  expect(sequencesStepUp("<Dialog>...</Dialog>")).toBe(false);
  expect(sequencesStepUp(PANEL_SOURCE)).toBe(true);
});

test("a surface that wires a session-kill on cancel reddens the abort guard", () => {
  expect(
    abortNeverKillsSession(
      'const abort = () => { signOut(); setPhase("idle"); };'
    )
  ).toBe(false);
  expect(
    abortNeverKillsSession("const abort = () => revokeSession(sid);")
  ).toBe(false);
  // Green control: the real panel's abort touches no session.
  expect(abortNeverKillsSession(PANEL_SOURCE)).toBe(true);
});

test("a surface with no polite live region reddens the announcement guard", () => {
  expect(hasPoliteLiveRegion('<div role="alert">done</div>')).toBe(false);
  expect(hasPoliteLiveRegion(PANEL_SOURCE)).toBe(true);
});

test("a surface with hard-coded copy reddens the catalog-routing guard", () => {
  expect(routesCopyThroughCatalog("<h2>Erase your account</h2>")).toBe(false);
  expect(routesCopyThroughCatalog(PANEL_SOURCE)).toBe(true);
});
