import { type FormEvent, useId, useState } from "react";

import { AuthFormShell } from "@/components/auth/auth-form-shell";
import { ErrorSummary } from "@/components/auth/error-summary";
import { PasswordField } from "@/components/auth/password-field";
import { Button } from "@/components/ui/button";
import { tAuth } from "@/lib/auth-strings";
import { useLocaleStore } from "@/lib/locale-store";

// The change-password surface. Used both as a standalone route and as the body
// of the non-dismissable forced-change gate, so it is form-only (no shell chrome
// when embedded). A single primary action that disables while pending; the new
// password carries the focusable reveal toggle.
export function ChangePasswordForm({
  embedded = false,
  onSubmit,
}: {
  embedded?: boolean;
  onSubmit?: (values: { newPassword: string }) => Promise<void>;
}) {
  const locale = useLocaleStore((state) => state.locale);
  const passwordId = useId();
  const summaryId = useId();

  const [newPassword, setNewPassword] = useState("");
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(undefined);
    setPending(true);
    try {
      await onSubmit?.({ newPassword });
    } catch {
      setFormError(tAuth(locale, "auth.error.generic"));
    } finally {
      setPending(false);
    }
  };

  const body = (
    <form className="space-y-4" noValidate onSubmit={handleSubmit}>
      <div className="space-y-2">
        <label className="text-xs" htmlFor={passwordId}>
          {tAuth(locale, "auth.field.newPassword.label")}
        </label>
        <PasswordField
          autoComplete="new-password"
          id={passwordId}
          locale={locale}
          name="newPassword"
          onChange={(event) => setNewPassword(event.target.value)}
          placeholder={tAuth(locale, "auth.field.newPassword.placeholder")}
          value={newPassword}
        />
      </div>

      <ErrorSummary id={summaryId} message={formError} />

      <Button
        className="w-full"
        data-primary="true"
        disabled={pending}
        type="submit"
      >
        {tAuth(locale, "auth.change.submit")}
      </Button>
    </form>
  );

  if (embedded) {
    return body;
  }
  return (
    <AuthFormShell title={tAuth(locale, "auth.change.title")}>
      {body}
    </AuthFormShell>
  );
}
