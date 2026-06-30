// The offline-reflection store — the single source for the observable "Working
// offline" connectivity flag the UI reflects.
//
// This is the natural home for the persistent quiet "Working offline" indicator
// state: a connectivity subscriber (Execute, wired from the browser online/offline
// signals + the data/sync seam's connectivity state) writes `online` through
// here, the `OfflineIndicator` reflects it, and exactly ONE Sonner toast is fired
// on the offline→online transition by that subscriber (not by every consumer).
//
// It does NOT compute any per-item freshness verdict — that is the data/sync
// seam's job (the single-owner verdict derive in @perry-starter/sync); this
// store only carries the coarse connectivity flag.
// zustand v5 has no default export (named `create`); a single-value selector
// needs no `useShallow`.

import { useEffect } from "react";
import { toast } from "sonner";
import { create } from "zustand";

export interface OfflineState {
  // True when the client observes connectivity; false drives "Working offline".
  readonly online: boolean;
  readonly setOnline: (online: boolean) => void;
}

export const useOfflineStore = create<OfflineState>((set) => ({
  online: true,
  setOnline: (online) => set({ online }),
}));

// Adopter-rewritable placeholder copy (keyed via the i18n string floor later).
const OFFLINE_TOAST = "Working offline. Your changes are saved on this device.";
const CATCH_UP_TOAST = "Back online. Your changes are up to date.";

// Subscribe the offline-reflection store to the browser connectivity signals and
// fire EXACTLY ONE Sonner toast per transition: a quiet "working offline" notice
// on disconnect, and a single calm catch-up confirmation on reconnect. The
// listeners attach ONCE (the subscriber owns the toast, never each consumer), so
// the indicator/components stay pure renderers. The catch-up toast is the honest
// reconnect confirmation; `up-to-date` itself remains gated on the per-id push
// ack owned by the data/sync seam — this toast never asserts durability the seam
// has not confirmed.
export const useConnectivitySubscriber = (): void => {
  const setOnline = useOfflineStore((state) => state.setOnline);
  useEffect(() => {
    setOnline(navigator.onLine);
    const handleOffline = () => {
      setOnline(false);
      toast.warning(OFFLINE_TOAST);
    };
    const handleOnline = () => {
      setOnline(true);
      toast.success(CATCH_UP_TOAST);
    };
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [setOnline]);
};
