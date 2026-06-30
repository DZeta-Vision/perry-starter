// The per-device FR/EN locale store (zustand v5, write-through to localStorage).
//
// A pre-auth, per-device visual choice: the language text toggle writes through
// here so every auth surface resolves its copy under the active locale. The full
// account-level locale persistence + the live runtime string-switch land in
// Epic 7; this is the auth-scope seam. v5 has no default export (named `create`),
// and a single-value selector needs no `useShallow`.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Locale } from "./auth-strings";

interface LocaleState {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly toggleLocale: () => void;
}

export const useLocaleStore = create<LocaleState>()(
  persist(
    (set) => ({
      locale: "en",
      setLocale: (locale) => set({ locale }),
      toggleLocale: () =>
        set((state) => ({ locale: state.locale === "en" ? "fr" : "en" })),
    }),
    { name: "perry-locale" }
  )
);
