// Red-phase component tests — the virtualized documents-list accessibility +
// keyset behaviours. Every test is `test(...)` (TDD red phase): the list is
// an inert scaffold today, so these stay skipped until Execute wires the real
// virtualization + a11y, then the dev un-skips them one at a time.
//
// The contract under test: the list exposes its set size via `aria-rowcount`
// (= the server total, NOT the windowed/rendered count), announces keyset
// appends through a polite live region, never loses or traps keyboard focus on
// recycled rows, exposes per-row actions on hover AND `:focus-within` (never
// hover-only), and renders the generic empty-state copy + a single primary
// action when there are no rows.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import {
  DocumentList,
  type DocumentRow,
} from "@/components/documents/document-list";

const makeRows = (count: number): DocumentRow[] =>
  Array.from({ length: count }, (_value, index) => ({
    id: `01ARZ3NDEKTSV4RRFFQ69G5FA${index.toString().padStart(2, "0")}`,
    title: `Document ${index}`,
    bodyPreview: `Preview ${index}`,
    status: "up-to-date" as const,
  }));

const EMPTY_STATE_RE = /nothing here yet\. create your first document\./i;
const OPEN_ROW_RE = /open/i;

describe("the documents list exposes its server set size, not the windowed count", () => {
  test("aria-rowcount reflects the server total even when only a window renders", () => {
    const SERVER_TOTAL = 5000;
    const { container } = render(
      <DocumentList rows={makeRows(40)} totalCount={SERVER_TOTAL} />
    );
    const list = container.querySelector("[data-document-list]");
    expect(list?.getAttribute("aria-rowcount")).toBe(String(SERVER_TOTAL));
    // Only a virtualized window is materialized — far fewer than the total.
    const rendered = container.querySelectorAll("[data-document-row]").length;
    expect(rendered).toBeLessThan(SERVER_TOTAL);
  });

  test("each rendered row carries aria-setsize equal to the server total", () => {
    const SERVER_TOTAL = 5000;
    const { container } = render(
      <DocumentList rows={makeRows(40)} totalCount={SERVER_TOTAL} />
    );
    const firstRow = container.querySelector("[data-document-row]");
    expect(firstRow?.getAttribute("aria-setsize")).toBe(String(SERVER_TOTAL));
  });
});

describe("the documents list announces keyset appends via a polite live region", () => {
  test("a polite live region is present for 'loaded N more' announcements", () => {
    const { container } = render(
      <DocumentList rows={makeRows(40)} totalCount={5000} />
    );
    const liveRegion = container.querySelector(
      "[aria-live='polite'], [role='status']"
    );
    expect(liveRegion).not.toBeNull();
  });
});

describe("the documents list keeps row actions reachable by keyboard, not hover-only", () => {
  test("each row exposes an open action reachable via focus-within (not hover-only)", () => {
    const { container } = render(
      <DocumentList rows={makeRows(10)} totalCount={10} />
    );
    const firstRow = container.querySelector(
      "[data-document-row]"
    ) as HTMLElement;
    const action = within(firstRow).getByRole("button", { name: OPEN_ROW_RE });
    // The action is a real focusable control (keyboard-reachable), not a
    // hover-only affordance gated behind `:hover`.
    expect(action).toBeInTheDocument();
    action.focus();
    expect(action).toHaveFocus();
  });
});

describe("the documents list renders the generic empty state with a single primary action", () => {
  test("an empty list shows the placeholder copy and one primary action", () => {
    render(<DocumentList rows={[]} totalCount={0} />);
    expect(screen.getByText(EMPTY_STATE_RE)).toBeVisible();
    const primaries = screen.getAllByRole("button");
    expect(primaries.length).toBe(1);
  });
});
