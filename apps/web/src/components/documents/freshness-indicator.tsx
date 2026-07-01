// Per-item freshness indicator — a PURE RENDERER of the single-owner sync
// verdict.
//
// The three-state verdict (up-to-date / syncing / may-be-stale) is computed in
// EXACTLY ONE place — the data/sync seam. This component receives the
// ALREADY-COMPUTED verdict as a prop and renders it. It MUST NOT re-derive the
// verdict from the raw integer cursors — a source guard forbids the seam's
// compute symbols and the cursor identifiers anywhere in the UI tier, so the UI
// can never drift from the seam or claim a false "saved to cloud".
//
// Accessibility floor: a REQUIRED text label per state ("Up to date" /
// "Syncing" / "May be out of date"), an `aria-label` per state, transitions
// announced via a `role="status"` live region, meaning NEVER carried by colour
// or icon alone, and NO teal — "Up to date" / "Syncing" use the muted freshness
// foreground (`--freshness-fg`), "May be out of date" the low-emphasis
// destructive hue.

import type { SyncStatus } from "@perry-starter/sync/sync-status";

// The verdict the seam owns. Re-aliased from the canonical seam enum so the UI
// renders exactly the seam's vocabulary and can never define a competing one.
export type FreshnessStatus = SyncStatus;

export interface FreshnessIndicatorProps {
  // The pre-computed verdict from the seam — never raw cursors.
  readonly status: FreshnessStatus;
}

// The per-state visible text label (the floor: a text label per state, never
// colour/icon alone). Each is distinct so no two states collapse.
const STATE_LABEL: Record<FreshnessStatus, string> = {
  "up-to-date": "Up to date",
  syncing: "Syncing",
  "may-be-stale": "May be out of date",
};

// A non-empty, distinct accessible name per state for assistive tech.
const STATE_ARIA_LABEL: Record<FreshnessStatus, string> = {
  "up-to-date": "Sync status: up to date",
  syncing: "Sync status: syncing",
  "may-be-stale": "Sync status: may be out of date",
};

// Per-state foreground. Durable/recent states use the muted freshness
// foreground; "may be out of date" uses the low-emphasis destructive hue. The
// teal brand (--primary) is never used to signal a state.
const STATE_CLASS: Record<FreshnessStatus, string> = {
  "up-to-date": "text-[color:var(--freshness-fg)]",
  syncing: "text-[color:var(--freshness-fg)]",
  "may-be-stale": "text-destructive",
};

export function FreshnessIndicator({ status }: FreshnessIndicatorProps) {
  return (
    <span
      aria-label={STATE_ARIA_LABEL[status]}
      className={`inline-flex items-center gap-1.5 text-sm ${STATE_CLASS[status]}`}
      data-freshness-indicator
      data-status={status}
      role="status"
    >
      <span
        aria-hidden="true"
        className={
          status === "syncing"
            ? "size-2 animate-pulse rounded-full bg-current"
            : "size-2 rounded-full bg-current"
        }
      />
      {STATE_LABEL[status]}
    </span>
  );
}
