import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tAuth } from "@/lib/auth-strings";
import { useLocaleStore } from "@/lib/locale-store";

// STEP_UP_REQUIRED -> the per-action step-up modal, raised OVER the surface.
//
// It is a SINGLE overlay (modal depth 1), built from a plain role="dialog" rather
// than a nested Dialog primitive, so it never stacks a dialog over a dialog. Unlike
// the forced-password-change gate it IS cancelable — but cancel aborts ONLY the
// action (the caller clears the paused action; the session is never touched).
// Escape and the Cancel button both cancel. On a prior failure the copy is the
// GENERIC, NON-NUMERIC step-up message (no countdown digits — a countdown would leak
// timing/rate state).
export function StepUpModal({
  onConfirm,
  onCancel,
  failed = false,
}: {
  onConfirm?: (credential: string) => void;
  onCancel?: () => void;
  failed?: boolean;
}) {
  const locale = useLocaleStore((state) => state.locale);
  const titleId = useId();
  const inputId = useId();
  const [credential, setCredential] = useState("");

  const cancel = () => onCancel?.();

  // Escape cancels the action (a session-safe dismiss). Bound at the document so the
  // dialog stays a non-interactive container (no handler on a non-interactive
  // element), and re-bound whenever the cancel handler identity changes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel?.();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div data-auth-treatment="step-up">
      {/* Backdrop: a single overlay (modal depth 1). Cancel is via the Cancel
          button or Escape — both abort ONLY the action, never the session. */}
      <div className="fixed inset-0 z-50 bg-black/50" />
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 border border-border bg-popover p-6 text-popover-foreground shadow-lg"
        role="dialog"
      >
        <h2 className="mb-4 font-semibold text-lg" id={titleId}>
          {tAuth(locale, "auth.stepUp.title")}
        </h2>
        <p className="mb-4 text-muted-foreground text-sm">
          {tAuth(locale, "auth.error.STEP_UP_REQUIRED")}
        </p>
        {failed ? (
          // Generic, NON-NUMERIC failure copy — never a precise countdown.
          <p
            className="mb-4 text-destructive text-sm"
            data-testid="step-up-error"
            role="alert"
          >
            {tAuth(locale, "auth.error.STEP_UP_REQUIRED")}
          </p>
        ) : null}
        <label className="mb-1 block font-medium text-sm" htmlFor={inputId}>
          {tAuth(locale, "auth.stepUp.codeLabel")}
        </label>
        <Input
          autoComplete="one-time-code"
          className="mt-1 mb-4"
          data-testid="step-up-credential-input"
          id={inputId}
          onChange={(event) => setCredential(event.target.value)}
          value={credential}
        />
        <div className="flex justify-end gap-2">
          <Button onClick={cancel} type="button" variant="outline">
            {tAuth(locale, "auth.stepUp.cancel")}
          </Button>
          <Button onClick={() => onConfirm?.(credential)} type="button">
            {tAuth(locale, "auth.stepUp.confirm")}
          </Button>
        </div>
      </section>
    </div>
  );
}
