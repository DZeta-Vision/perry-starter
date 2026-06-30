import { type FormEvent, useId, useState } from "react";

import { AuthFormShell } from "@/components/auth/auth-form-shell";
import { ErrorSummary } from "@/components/auth/error-summary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tAuth } from "@/lib/auth-strings";
import { useLocaleStore } from "@/lib/locale-store";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The reset-request surface. Anti-enumeration is load-bearing here: the response
// is ALWAYS the same neutral "maybe sent" copy whether or not the address has an
// account — a registered and an unregistered email render byte-identical copy, so
// the surface never confirms account existence.
export function ResetPasswordForm({
  onSubmit,
}: {
  onSubmit?: (values: { email: string }) => Promise<void>;
}) {
  const locale = useLocaleStore((state) => state.locale);
  const emailId = useId();
  const emailErrorId = useId();
  const summaryId = useId();

  const [email, setEmail] = useState("");
  const [emailInvalid, setEmailInvalid] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!EMAIL_RE.test(email)) {
      setEmailInvalid(true);
      setMessage(tAuth(locale, "auth.error.generic"));
      return;
    }
    setEmailInvalid(false);
    setPending(true);
    try {
      await onSubmit?.({ email });
    } catch {
      // Swallowed on purpose: the outcome must not change the copy.
    } finally {
      // The SAME neutral copy regardless of whether the account exists.
      setMessage(tAuth(locale, "auth.neutral.maybeSent"));
      setPending(false);
    }
  };

  return (
    <AuthFormShell title={tAuth(locale, "auth.reset.title")}>
      <form className="space-y-4" noValidate onSubmit={handleSubmit}>
        <div className="space-y-2">
          <label className="text-xs" htmlFor={emailId}>
            {tAuth(locale, "auth.field.email.label")}
          </label>
          <Input
            aria-describedby={emailInvalid ? emailErrorId : undefined}
            aria-invalid={emailInvalid || undefined}
            autoComplete="email"
            id={emailId}
            name="email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder={tAuth(locale, "auth.field.email.placeholder")}
            type="email"
            value={email}
          />
          {emailInvalid ? (
            <p className="text-destructive text-xs" id={emailErrorId}>
              {tAuth(locale, "auth.error.generic")}
            </p>
          ) : null}
        </div>

        <ErrorSummary id={summaryId} message={message} />

        <Button
          className="w-full"
          data-primary="true"
          disabled={pending}
          type="submit"
        >
          {tAuth(locale, "auth.reset.submit")}
        </Button>
      </form>
    </AuthFormShell>
  );
}
