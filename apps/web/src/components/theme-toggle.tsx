import { Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTheme } from "next-themes";

import { Button } from "./ui/button";

// Light/dark theme toggle. Defaults to the system preference and persists the
// per-device choice through next-themes (which writes the resolved class to
// <html>). Carries an accessible name and a ≥24px target.
export default function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  return (
    <Button
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      size="icon"
      type="button"
      variant="ghost"
    >
      <HugeiconsIcon
        aria-hidden="true"
        icon={isDark ? Sun03Icon : Moon02Icon}
      />
    </Button>
  );
}
