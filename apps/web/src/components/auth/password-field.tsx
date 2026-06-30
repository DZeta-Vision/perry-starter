import { ViewIcon, ViewOffSlashIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type Locale, tAuth } from "@/lib/auth-strings";

// The WCAG 2.5.8 target floor (24×24 CSS px). Set as an explicit min size so the
// guarantee holds regardless of the icon-button variant, and is assertable in a
// jsdom unit test (which does not compute layout).
const MIN_TARGET_PX = 24;

type PasswordFieldProps = Omit<React.ComponentProps<typeof Input>, "type"> & {
  readonly locale?: Locale;
};

// A password input with an in-field trailing reveal toggle. The toggle is a real,
// keyboard-focusable <button> with a locale-aware accessible name (Show/Hide
// password), an announced `aria-pressed` state, and a ≥24px target; activating it
// flips BOTH aria-pressed and the input `type` (password <-> text). The eye glyph
// is decorative (aria-hidden) — the name comes from the button's aria-label.
export function PasswordField({
  locale = "en",
  className,
  ...inputProps
}: PasswordFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const revealName = revealed
    ? tAuth(locale, "auth.reveal.hide")
    : tAuth(locale, "auth.reveal.show");

  return (
    <div className="relative">
      <Input
        className={className}
        type={revealed ? "text" : "password"}
        {...inputProps}
      />
      <Button
        aria-label={revealName}
        aria-pressed={revealed}
        className="absolute inset-y-0 right-0 my-auto mr-1"
        onClick={() => setRevealed((current) => !current)}
        size="icon-sm"
        style={{ minHeight: MIN_TARGET_PX, minWidth: MIN_TARGET_PX }}
        type="button"
        variant="ghost"
      >
        <HugeiconsIcon
          aria-hidden="true"
          icon={revealed ? ViewOffSlashIcon : ViewIcon}
        />
      </Button>
    </div>
  );
}
