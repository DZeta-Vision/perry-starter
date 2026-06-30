import { useEffect } from "react";
import { toast } from "sonner";

import SignInForm from "@/components/sign-in-form";
import { Button } from "@/components/ui/button";
import type { AuthTreatment } from "@/lib/auth-error";
import { tAuth } from "@/lib/auth-strings";
import { useLocaleStore } from "@/lib/locale-store";
import { safeReturnTo } from "@/lib/return-to";

// The forward control every non-dismissable / terminal surface offers, so none is
// ever a dead-end (back to sign in). Rendered as a non-primary action.
function ForwardToSignIn({ onForward }: { onForward?: () => void }) {
  const locale = useLocaleStore((state) => state.locale);
  return (
    <div className="mt-4 text-center">
      <Button onClick={onForward} type="button" variant="link">
        {tAuth(locale, "auth.forward.backToSignIn")}
      </Button>
    </div>
  );
}

// A generic centered surface stamped with its `data-auth-treatment` marker (the
// coverage-map reads these to prove the 8 codes resolve to 8 distinct screens).
function AuthSurface({
  treatment,
  title,
  body,
  children,
}: {
  treatment: AuthTreatment;
  title: string;
  body?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="mx-auto mt-10 w-full max-w-md p-6 text-center"
      data-auth-treatment={treatment}
    >
      <h1 className="mb-4 font-bold text-2xl">{title}</h1>
      {body ? (
        <p className="mb-4 text-muted-foreground text-sm">{body}</p>
      ) : null}
      {children}
    </div>
  );
}

// UNAUTHORIZED -> the generic sign-in surface.
export function SignInTreatment({ onForward }: { onForward?: () => void }) {
  return (
    <div data-auth-treatment="sign-in">
      <SignInForm onSwitchToSignUp={onForward} />
    </div>
  );
}

// SESSION_EXPIRED -> a Sonner toast + the sign-in surface, preserving only an
// allowlist-validated returnTo destination (open-redirect guard). The toast fires
// once on mount; the validated destination is exposed for the post-recovery hop.
export function SessionExpiredTreatment({
  returnTo,
}: {
  returnTo?: string | null;
}) {
  const locale = useLocaleStore((state) => state.locale);
  const destination = safeReturnTo(returnTo);

  useEffect(() => {
    toast(tAuth(locale, "auth.error.SESSION_EXPIRED"));
  }, [locale]);

  return (
    <div data-auth-treatment="session-expired" data-return-to={destination}>
      <SignInForm />
    </div>
  );
}

// EMAIL_NOT_VERIFIED -> the verification wall + a rate-limited resend whose copy
// is NON-numeric (no countdown — a countdown would leak rate/timing state).
export function VerificationWall({
  onResend,
  onForward,
}: {
  onResend?: () => void;
  onForward?: () => void;
}) {
  const locale = useLocaleStore((state) => state.locale);
  return (
    <AuthSurface
      body={tAuth(locale, "auth.error.EMAIL_NOT_VERIFIED")}
      title={tAuth(locale, "auth.error.EMAIL_NOT_VERIFIED")}
      treatment="verify-email"
    >
      <Button onClick={onResend} type="button" variant="outline">
        {tAuth(locale, "auth.verify.resend")}
      </Button>
      <ForwardToSignIn onForward={onForward} />
    </AuthSurface>
  );
}

// ACCOUNT_LOCKED -> the locked surface + a Turnstile widget container (siteverify
// is SERVER-SIDE on the Worker — this only RENDERS the widget) and generic
// NON-numeric copy. Any retryAfter is consumed silently: no countdown digits.
export function AccountLocked({ onForward }: { onForward?: () => void }) {
  const locale = useLocaleStore((state) => state.locale);
  return (
    <AuthSurface
      body={tAuth(locale, "auth.error.ACCOUNT_LOCKED")}
      title={tAuth(locale, "auth.error.ACCOUNT_LOCKED")}
      treatment="account-locked"
    >
      {/* Turnstile mounts here; its token is verified server-side on the Worker. */}
      <div
        className="mx-auto my-4 h-16 w-full max-w-xs bg-muted"
        data-sitekey="placeholder"
        data-turnstile=""
      />
      <ForwardToSignIn onForward={onForward} />
    </AuthSurface>
  );
}

// FORBIDDEN -> a generic "no access" surface (no resource/role leak).
export function NoAccess({ onForward }: { onForward?: () => void }) {
  const locale = useLocaleStore((state) => state.locale);
  return (
    <AuthSurface
      body={tAuth(locale, "auth.error.FORBIDDEN")}
      title={tAuth(locale, "auth.error.FORBIDDEN")}
      treatment="no-access"
    >
      <ForwardToSignIn onForward={onForward} />
    </AuthSurface>
  );
}

// TWO_FACTOR_REQUIRED -> a DEFINED placeholder TOTP-enrol route (D6). The backend
// lands in Epic 5; the stub is reachable, non-keyboard-trap, and always offers a
// forward path (back to sign in).
export function TwoFactorPlaceholder({
  onForward,
}: {
  onForward?: () => void;
}) {
  const locale = useLocaleStore((state) => state.locale);
  return (
    <AuthSurface
      body={tAuth(locale, "auth.error.TWO_FACTOR_REQUIRED")}
      title={tAuth(locale, "auth.error.TWO_FACTOR_REQUIRED")}
      treatment="two-factor"
    >
      <ForwardToSignIn onForward={onForward} />
    </AuthSurface>
  );
}

// STEP_UP_REQUIRED -> a DEFINED placeholder step-up route (D6), rendered as a
// single surface (never a dialog over a dialog). Non-keyboard-trap, with a
// forward path. The backend lands in Epic 5.
export function StepUpPlaceholder({ onForward }: { onForward?: () => void }) {
  const locale = useLocaleStore((state) => state.locale);
  return (
    <AuthSurface
      body={tAuth(locale, "auth.error.STEP_UP_REQUIRED")}
      title={tAuth(locale, "auth.error.STEP_UP_REQUIRED")}
      treatment="step-up"
    >
      <ForwardToSignIn onForward={onForward} />
    </AuthSurface>
  );
}
