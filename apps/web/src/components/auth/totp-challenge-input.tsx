import { useId } from "react";

import { Input } from "@/components/ui/input";
import { tAuth } from "@/lib/auth-strings";
import { useLocaleStore } from "@/lib/locale-store";

// The TOTP challenge input — WCAG 2.2 §3.3.8 (Accessible Authentication).
//
// It PERMITS paste (no `onPaste` interception) and carries
// `autocomplete="one-time-code"` + `inputMode="numeric"` so an authenticator app
// or password manager can autofill the code and the on-screen keyboard offers the
// numeric pad. It is a labelled single field — never a per-digit split that blocks
// paste and defeats autofill.
export function TotpChallengeInput({
  value,
  onValueChange,
}: {
  value?: string;
  onValueChange?: (next: string) => void;
}) {
  const locale = useLocaleStore((state) => state.locale);
  const inputId = useId();
  return (
    <div className="mx-auto w-full max-w-xs text-left">
      <label className="mb-1 block font-medium text-xs" htmlFor={inputId}>
        {tAuth(locale, "auth.twoFactor.codeLabel")}
      </label>
      <Input
        autoComplete="one-time-code"
        data-testid="totp-code-input"
        id={inputId}
        inputMode="numeric"
        name="one-time-code"
        onChange={(event) => onValueChange?.(event.target.value)}
        placeholder="000000"
        value={value}
      />
    </div>
  );
}
