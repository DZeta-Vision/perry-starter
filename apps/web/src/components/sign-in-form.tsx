import { type FormEvent, useId, useState } from "react";

import { AuthFormShell } from "@/components/auth/auth-form-shell";
import { ErrorSummary } from "@/components/auth/error-summary";
import { PasswordField } from "@/components/auth/password-field";
import { tAuth } from "@/lib/auth-strings";
import { useLocaleStore } from "@/lib/locale-store";

import { Button } from "./ui/button";
import { Input } from "./ui/input";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The sign-in surface. Accessible by construction: a real <label> + meaningful
// placeholder per input, a focusable reveal toggle, inline errors tied via
// aria-invalid + aria-describedby with a polite live-region summary, a single
// primary action that disables while pending, and GENERIC anti-enumeration error
// copy (a failed submit never reveals whether the email exists or its state).
export default function SignInForm({
  onSwitchToSignUp,
  onSubmit,
}: {
  onSwitchToSignUp?: () => void;
  onSubmit?: (values: { email: string; password: string }) => Promise<void>;
}) {
  const locale = useLocaleStore((state) => state.locale);
  const emailId = useId();
  const emailErrorId = useId();
  const summaryId = useId();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailInvalid, setEmailInvalid] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!EMAIL_RE.test(email)) {
      setEmailInvalid(true);
      setFormError(tAuth(locale, "auth.error.generic"));
      return;
    }
    setEmailInvalid(false);
    setFormError(undefined);
    setPending(true);
    try {
      await onSubmit?.({ email, password });
    } catch {
      // Every failure resolves to the SAME generic copy — never a state- or
      // existence-revealing message.
      setFormError(tAuth(locale, "auth.error.generic"));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthFormShell title={tAuth(locale, "auth.signIn.title")}>
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

        <div className="space-y-2">
          <label className="text-xs" htmlFor="signin-password">
            {tAuth(locale, "auth.field.password.label")}
          </label>
          <PasswordField
            autoComplete="current-password"
            id="signin-password"
            locale={locale}
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            placeholder={tAuth(locale, "auth.field.password.placeholder")}
            value={password}
          />
        </div>

        <ErrorSummary id={summaryId} message={formError} />

        <Button
          className="w-full"
          data-primary="true"
          disabled={pending}
          type="submit"
        >
          {tAuth(locale, "auth.signIn.submit")}
        </Button>
      </form>

      {onSwitchToSignUp ? (
        <div className="mt-4 text-center">
          <Button onClick={onSwitchToSignUp} type="button" variant="link">
            {tAuth(locale, "auth.signIn.switch")}
          </Button>
        </div>
      ) : null}
    </AuthFormShell>
  );
}
