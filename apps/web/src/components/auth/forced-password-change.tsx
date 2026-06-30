import { useId } from "react";

import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { tAuth } from "@/lib/auth-strings";
import { useLocaleStore } from "@/lib/locale-store";

// PASSWORD_CHANGE_REQUIRED -> a NON-DISMISSABLE forced-change block.
//
// It is a modal surface (role="dialog", aria-modal) that cannot be dismissed:
// there is no close button, Escape does not close it, and clicking the backdrop
// does not close it — the only way out is setting a new password (the gate ALWAYS
// offers that one forward path, so it is never a keyboard-trap dead-end). It is a
// single overlay (modal depth 1), built from a plain role="dialog" rather than a
// nested Dialog primitive, so it neither stacks a dialog over a dialog nor wires
// any dismiss affordance. The change-password form is embedded as the body.
export function ForcedPasswordChange({
  onSubmit,
}: {
  onSubmit?: (values: { newPassword: string }) => Promise<void>;
}) {
  const locale = useLocaleStore((state) => state.locale);
  const titleId = useId();

  return (
    <div data-auth-treatment="forced-password-change">
      {/* Backdrop: no onClick — clicking it does not dismiss the gate. */}
      <div className="fixed inset-0 z-50 bg-black/50" />
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 border border-border bg-popover p-6 text-popover-foreground shadow-lg"
        role="dialog"
      >
        <h2 className="mb-4 font-semibold text-lg" id={titleId}>
          {tAuth(locale, "auth.change.title")}
        </h2>
        <p className="mb-4 text-muted-foreground text-sm">
          {tAuth(locale, "auth.error.PASSWORD_CHANGE_REQUIRED")}
        </p>
        <ChangePasswordForm embedded onSubmit={onSubmit} />
      </section>
    </div>
  );
}
