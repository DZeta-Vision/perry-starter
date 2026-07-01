// Red-phase component tests — the persistent quiet "Working offline" indicator.
// Every test is `test(...)` (TDD red phase): the indicator is inert today.
//
// The contract under test: while offline the indicator renders a quiet,
// non-modal "Working offline" text label inside a `role="status"` live region
// (the accessibility floor — a text label, never colour/icon alone), it is never a
// blocking spinner, and when online it is silent. The single Sonner toast on the
// offline transition is asserted at the e2e tier (the connectivity subscriber
// fires it once), not here.

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { OfflineIndicator } from "@/components/documents/offline-indicator";

const WORKING_OFFLINE_RE = /working offline/i;

describe("the offline indicator is a quiet role=status label while offline", () => {
  test("offline renders the 'Working offline' text label", () => {
    render(<OfflineIndicator online={false} />);
    expect(screen.getByText(WORKING_OFFLINE_RE)).toBeVisible();
  });

  test("the offline status lives in a role=status live region", () => {
    render(<OfflineIndicator online={false} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(WORKING_OFFLINE_RE);
  });

  test("the offline indicator is not a blocking spinner (no progressbar)", () => {
    render(<OfflineIndicator online={false} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  test("online renders no 'Working offline' label (silent when connected)", () => {
    render(<OfflineIndicator online={true} />);
    expect(screen.queryByText(WORKING_OFFLINE_RE)).toBeNull();
  });
});
