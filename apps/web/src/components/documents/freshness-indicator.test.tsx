// Red-phase component tests — the per-item freshness indicator accessibility
// floor. Every test is `test(...)` (TDD red phase): the indicator is an
// inert scaffold today, so these stay skipped until Execute renders the real
// per-state label / aria / live-region presentation, then the dev un-skips them
// one at a time.
//
// The contract under test: each of the three verdict states renders a DISTINCT
// required text label and an `aria-label`, transitions announce via a
// `role="status"` live region, meaning is never carried by colour or icon alone,
// and the teal brand hue is never used to signal a state. The component is a pure
// renderer of the seam verdict (the source guard proves it does not re-derive).

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import {
  FreshnessIndicator,
  type FreshnessStatus,
} from "@/components/documents/freshness-indicator";

// The required per-state text labels (the accessibility floor — a text label
// per state, never colour/icon alone).
const STATE_LABELS: Record<FreshnessStatus, RegExp> = {
  "up-to-date": /up to date/i,
  syncing: /syncing/i,
  "may-be-stale": /may be out of date/i,
};

const ALL_STATES: readonly FreshnessStatus[] = [
  "up-to-date",
  "syncing",
  "may-be-stale",
];

// Teal is the brand primary; a state must never be signalled by it (or by colour
// alone). Match the teal hue family in the resolved class/inline-style surface.
const TEAL_HINT_RE = /teal|primary|var\(--primary\)/i;

describe("the freshness indicator renders a required text label per state", () => {
  for (const status of ALL_STATES) {
    test(`the "${status}" verdict renders its distinct text label`, () => {
      render(<FreshnessIndicator status={status} />);
      expect(screen.getByText(STATE_LABELS[status])).toBeVisible();
    });
  }

  test("the three states render three distinct labels (no two collapse)", () => {
    const seen = new Set<string>();
    for (const status of ALL_STATES) {
      const { container, unmount } = render(
        <FreshnessIndicator status={status} />
      );
      seen.add((container.textContent ?? "").trim());
      unmount();
    }
    expect(seen.size).toBe(ALL_STATES.length);
  });
});

describe("the freshness indicator carries an aria-label per state and announces via role=status", () => {
  for (const status of ALL_STATES) {
    test(`the "${status}" verdict exposes a non-empty aria-label`, () => {
      const { container } = render(<FreshnessIndicator status={status} />);
      const indicator = container.querySelector("[data-freshness-indicator]");
      expect(
        (indicator?.getAttribute("aria-label") ?? "").trim().length
      ).toBeGreaterThan(0);
    });
  }

  test("verdict transitions live in a role=status region for announcement", () => {
    render(<FreshnessIndicator status="syncing" />);
    // The transition is announced via a polite status live region.
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

describe("the freshness indicator never signals meaning by colour alone (no teal)", () => {
  for (const status of ALL_STATES) {
    test(`the "${status}" verdict carries a text label, not a teal-only signal`, () => {
      const { container } = render(<FreshnessIndicator status={status} />);
      // A non-empty text label is always present (meaning is not colour-only).
      expect((container.textContent ?? "").trim().length).toBeGreaterThan(0);
      // And no state is conveyed via the teal brand hue.
      const indicator = container.querySelector("[data-freshness-indicator]");
      const className = indicator?.getAttribute("class") ?? "";
      const style = indicator?.getAttribute("style") ?? "";
      expect(`${className} ${style}`).not.toMatch(TEAL_HINT_RE);
    });
  }
});
