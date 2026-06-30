import { type FormEvent, useId, useState } from "react";

import { AuthFormShell } from "@/components/auth/auth-form-shell";
import { ErrorSummary } from "@/components/auth/error-summary";
import { PasswordField } from "@/components/auth/password-field";
import { tAuth } from "@/lib/auth-strings";
import { useLocaleStore } from "@/lib/locale-store";

import { Button } from "./ui/button";
import { Input } from "./ui/input";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The sign-up surface. Same accessible-form contract as sign-in (centered
// max-w-md column, real labels + meaningful placeholders, focusable reveal,
// aria-invalid + aria-describedby + polite summary, single primary that disables
// while pending) and the SAME generic anti-enumeration error copy — a failed
// sign-up never reveals "already registered".
export default function SignUpForm({
  onSwitchToSignIn,
  onSubmit,
}: {
  onSwitchToSignIn?: () => void;
  onSubmit?: (values: {
    name: string;
    email: string;
    password: string;
  }) => Promise<void>;
}) {
  const locale = useLocaleStore((state) => state.locale);
  const emailId = useId();
  const emailErrorId = useId();
  const summaryId = useId();

  const [name, setName] = useState("");
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
      await onSubmit?.({ name, email, password });
    } catch {
      setFormError(tAuth(locale, "auth.error.generic"));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthFormShell title={tAuth(locale, "auth.signUp.title")}>
      <form className="space-y-4" noValidate onSubmit={handleSubmit}>
        <div className="space-y-2">
          <label className="text-xs" htmlFor="signup-name">
            {tAuth(locale, "auth.field.name.label")}
          </label>
          <Input
            autoComplete="name"
            id="signup-name"
            name="name"
            onChange={(event) => setName(event.target.value)}
            placeholder={tAuth(locale, "auth.field.name.placeholder")}
            type="text"
            value={name}
          />
        </div>

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
          <label className="text-xs" htmlFor="signup-password">
            {tAuth(locale, "auth.field.password.label")}
          </label>
          <PasswordField
            autoComplete="new-password"
            id="signup-password"
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
          {tAuth(locale, "auth.signUp.submit")}
        </Button>
      </form>

      {onSwitchToSignIn ? (
        <div className="mt-4 text-center">
          <Button onClick={onSwitchToSignIn} type="button" variant="link">
            {tAuth(locale, "auth.signUp.switch")}
          </Button>
        </div>
      ) : null}
    </AuthFormShell>
  );
}
