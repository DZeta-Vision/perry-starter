// Red-phase source guard — the freshness indicator is a PURE RENDERER of the
// single-owner seam verdict and MUST NOT re-derive it from raw cursor fields.
// Every test is `test(...)` (TDD red phase) so the red-phase suite stays
// fully skipped; Execute un-skips it (and may promote it to a paired
// `*.gate.test.ts` + `*.mutation.test.ts` per the conformance-gate discipline).
//
// Why this guard exists: the freshness verdict (up-to-date / syncing /
// may-be-stale) is computed in EXACTLY ONE place — the data/sync seam. If the
// UI imported the raw integer cursors and recomputed the verdict, it would be a
// second owner that could drift from the seam and render a premature/false
// "saved to cloud". This guard scans the indicator source and asserts it
// references NONE of the raw cursor inputs and does NOT call the seam's compute
// functions — it only consumes the already-computed `status` verdict prop.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Resolve the indicator source via node:path (NOT the `new URL(relative,
// import.meta.url)` idiom, which Vite rewrites into a non-file asset URL).
const HERE = dirname(fileURLToPath(import.meta.url));
const INDICATOR_SOURCE = resolve(
  HERE,
  "..",
  "components",
  "documents",
  "freshness-indicator.tsx"
);

// The raw integer-cursor inputs the seam derives the verdict from. None of these
// may appear in the indicator source — their presence would mean the UI is
// re-deriving the verdict rather than rendering the seam's pre-computed one.
const FORBIDDEN_CURSOR_IDENTIFIERS = [
  "updated_cursor",
  "acked_cursor",
  "latest_known_server_cursor",
  "unacked_count",
  "projection_cursor",
];

// The seam's compute functions; importing/calling either here would make the UI
// a second verdict owner.
const FORBIDDEN_SEAM_COMPUTE = ["computeSyncStatus", "deriveItemSyncStatus"];

// The public prop surface must be the pre-computed verdict, not raw cursors.
const VERDICT_PROP_RE = /status\s*:\s*FreshnessStatus/;

const readIndicatorSource = (): string =>
  readFileSync(INDICATOR_SOURCE, "utf8");

describe("the freshness indicator consumes the seam verdict and never re-derives it", () => {
  test("the indicator source references no raw cursor field", () => {
    const source = readIndicatorSource();
    for (const identifier of FORBIDDEN_CURSOR_IDENTIFIERS) {
      expect(
        source.includes(identifier),
        `freshness indicator must not reference the raw cursor field "${identifier}"`
      ).toBe(false);
    }
  });

  test("the indicator source does not call the seam compute functions", () => {
    const source = readIndicatorSource();
    for (const symbol of FORBIDDEN_SEAM_COMPUTE) {
      expect(
        source.includes(`${symbol}(`),
        `freshness indicator must not call the seam compute function "${symbol}" — it renders the pre-computed verdict`
      ).toBe(false);
    }
  });

  test("the indicator's public prop surface is the verdict, not raw cursors", () => {
    const source = readIndicatorSource();
    // The component takes the pre-computed `status` verdict.
    expect(source).toMatch(VERDICT_PROP_RE);
  });
});
