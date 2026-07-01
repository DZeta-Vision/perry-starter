// Mutation twin for sync-status-single-owner.gate.test.ts — proves the
// single-owner / UI source-guard detector actually fires.
//
// A guard that scans for a forbidden reference but could never detect one is
// vacuous. This twin re-implements the detector inline and feeds it synthetic
// sources: a second computing site, a UI that re-derives from raw cursors, and a
// UI that imports the predicate — each must be flagged — plus a clean UI that
// only renders the verdict, which must NOT be flagged.
//
// RED PHASE: every test is skipped until the seam is implemented.

import { describe, expect, test } from "vitest";

const COMPUTE_SYMBOLS = ["computeSyncStatus", "deriveItemSyncStatus"];
const RAW_CURSOR_FIELDS = [
  "updated_cursor",
  "acked_cursor",
  "latest_known_server_cursor",
  "projection_cursor",
];

const referencesAny = (source: string, needles: readonly string[]): boolean =>
  needles.some((needle) => source.includes(needle));

// A second site that computes the verdict (forbidden outside the seam tier).
const secondComputingSite = [
  'import { computeSyncStatus } from "@perry-starter/sync";',
  "export const status = (i) => computeSyncStatus(i);",
].join("\n");

// A UI component that re-derives the verdict from raw cursor fields (forbidden).
const uiRederivesFromCursors = [
  "export function Badge({ updated_cursor, acked_cursor }) {",
  '  return updated_cursor <= acked_cursor ? "up-to-date" : "syncing";',
  "}",
].join("\n");

// A UI component that imports the seam-derive directly (forbidden).
const uiImportsSeam = [
  'import { deriveItemSyncStatus } from "@perry-starter/sync";',
  "export const Badge = (item) => deriveItemSyncStatus(item);",
].join("\n");

// A clean UI component: imports only the opaque verdict and renders it.
const cleanUi = [
  'import type { SyncStatus } from "@perry-starter/sync";',
  "export function Badge({ status }: { status: SyncStatus }) {",
  "  return status;",
  "}",
].join("\n");

describe("the single-owner detector fires on a second computing site", () => {
  test("flags a non-seam module that computes the verdict", () => {
    expect(referencesAny(secondComputingSite, COMPUTE_SYMBOLS)).toBe(true);
  });
});

describe("the UI source-guard detector fires on re-derivation", () => {
  test("flags a UI component that re-derives the verdict from raw cursor fields", () => {
    expect(referencesAny(uiRederivesFromCursors, RAW_CURSOR_FIELDS)).toBe(true);
  });

  test("flags a UI component that imports the seam-derive directly", () => {
    expect(referencesAny(uiImportsSeam, COMPUTE_SYMBOLS)).toBe(true);
  });

  test("does not flag a clean UI component that only renders the opaque verdict", () => {
    expect(referencesAny(cleanUi, COMPUTE_SYMBOLS)).toBe(false);
    expect(referencesAny(cleanUi, RAW_CURSOR_FIELDS)).toBe(false);
  });
});
