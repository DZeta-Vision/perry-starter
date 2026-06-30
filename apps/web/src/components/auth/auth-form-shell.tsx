import type { ReactNode } from "react";

import LanguageToggle from "@/components/language-toggle";
import ThemeToggle from "@/components/theme-toggle";

// The shared auth-surface chrome: a horizontally centered, max-w-md-bounded
// column that mounts the theme toggle and the FR·EN text language toggle on
// EVERY surface — including pre-auth — so both affordances are reachable before a
// session exists. The column grows/wraps with its content (no fixed width), so a
// +35% FR string never truncates.
export function AuthFormShell({
  children,
  title,
  headingId,
}: {
  readonly children: ReactNode;
  readonly title: string;
  readonly headingId?: string;
}) {
  return (
    <div className="mx-auto mt-10 w-full max-w-md p-6">
      <div className="mb-4 flex justify-end gap-2">
        <ThemeToggle />
        <LanguageToggle />
      </div>
      <h1 className="mb-6 text-center font-bold text-3xl" id={headingId}>
        {title}
      </h1>
      {children}
    </div>
  );
}
