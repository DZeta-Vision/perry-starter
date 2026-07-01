// Persistent quiet "Working offline" status indicator.
//
// Reflects the observable connectivity state (the offline-reflection store, see
// `@/lib/offline-store`). It is a quiet, NON-MODAL status — never a blocking
// spinner — and never blocks local-first writes. It renders a `role="status"`
// live region carrying the "Working offline" text label (the floor: a text
// label, not colour/icon alone). When connected it is silent (renders nothing).
//
// The single Sonner toast on the offline→online transition is fired ONCE by the
// connectivity subscriber (route/store wiring), not duplicated by this
// component — this is a pure renderer of the connectivity flag.

export interface OfflineIndicatorProps {
  // True when the client observes connectivity; false renders "Working offline".
  readonly online: boolean;
}

export function OfflineIndicator({ online }: OfflineIndicatorProps) {
  if (online) {
    // Silent when connected — no persistent chrome, no spinner.
    return null;
  }

  return (
    <span
      aria-label="Connectivity status: working offline"
      className="inline-flex items-center gap-1.5 text-[color:var(--freshness-fg)] text-sm"
      data-offline-indicator
      data-online={online}
      role="status"
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-current" />
      Working offline
    </span>
  );
}
