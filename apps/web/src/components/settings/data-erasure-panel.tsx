// The GDPR erasure panel — destructive-confirm + per-action step-up.
//
// Erasure is dangerous, so it is guarded by a DESTRUCTIVE-CONFIRM dialog (a single
// modal — never a dialog stacked over another) and THEN a step-up re-auth. The two
// modals are SEQUENCED, never nested: the confirm dialog closes before the step-up
// modal opens, so modal depth stays one (the modal-depth conformance gate). The
// step-up must be freshly satisfied for THIS action — a prior grant never carries
// over — and the credential is entered per request.
//
// SESSION-SAFE: cancelling the confirm OR the step-up aborts ONLY the erasure action
// (the panel resets to idle). There is NO session/logout effect anywhere here — a
// mis-step can never self-inflict a logout. The erasure-recorded confirmation rides a
// POLITE live region (`aria-live="polite"` / role="status"), announced without a
// focus steal. Every visible string is locale-keyed (EN/FR) via `data-rights-strings`.
//
// The network call is an INJECTED seam (`onErase`) so the panel is a pure, testable
// renderer; the route wires the real re-auth + step-up-guarded tRPC mutation.

import { useState } from "react";

import { StepUpModal } from "@/components/auth/step-up-modal";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type DataRightsKey,
  type Locale,
  tDataRights,
} from "@/lib/data-rights-strings";
import { STEP_UP_MAX_ATTEMPTS } from "@/lib/step-up-controller";

// The erasure outcome the seam resolves. `step-up-required` raises the step-up modal
// (the server challenged); `done` means the soft-delete + registration + audit landed.
export type ErasureOutcome =
  | { readonly status: "step-up-required" }
  | { readonly status: "done" };

type ErasurePhase =
  | "idle"
  | "confirming"
  | "stepping-up"
  | "pending"
  | "done"
  | "error";

export interface DataErasurePanelProps {
  readonly locale: Locale;
  // The erasure seam: called with NO step-up on the first attempt (the server
  // challenges → step-up-required) and with the re-auth credential to resume. So a
  // prior grant never satisfies it — the credential is presented for THIS action.
  readonly onErase: (stepUp?: {
    readonly credential: string;
  }) => Promise<ErasureOutcome>;
}

export function DataErasurePanel({ locale, onErase }: DataErasurePanelProps) {
  const [phase, setPhase] = useState<ErasurePhase>("idle");
  const [failed, setFailed] = useState(0);

  const t = (key: DataRightsKey): string => tDataRights(locale, key);

  // Abort the action only — reset local state. NO session effect exists here, so a
  // cancel/abort can never revoke the session.
  const abort = () => {
    setPhase("idle");
    setFailed(0);
  };

  const runErase = async (credential?: string) => {
    setPhase("pending");
    try {
      const outcome = await onErase(
        credential === undefined ? undefined : { credential }
      );
      if (outcome.status === "done") {
        setFailed(0);
        setPhase("done");
        return;
      }
      // step-up-required. On the FIRST attempt (no credential) raise the modal; on a
      // credential re-attempt count the failure and abort the ACTION at the ceiling.
      if (credential === undefined) {
        setPhase("stepping-up");
        return;
      }
      const next = failed + 1;
      if (next >= STEP_UP_MAX_ATTEMPTS) {
        abort();
        return;
      }
      setFailed(next);
      setPhase("stepping-up");
    } catch {
      setPhase("error");
    }
  };

  return (
    <section aria-labelledby="data-erasure-heading" className="space-y-3">
      <h2 className="font-semibold text-lg" id="data-erasure-heading">
        {t("dataRights.erasure.heading")}
      </h2>
      <p
        className="block text-muted-foreground text-sm"
        id="data-erasure-description"
      >
        {t("dataRights.erasure.description")}
      </p>
      <Button
        aria-describedby="data-erasure-description"
        disabled={phase === "pending"}
        onClick={() => setPhase("confirming")}
        type="button"
        variant="destructive"
      >
        {t("dataRights.erasure.action")}
      </Button>

      {/* The destructive-confirm dialog — a SINGLE modal. Cancel/close aborts ONLY the
          action (session untouched). It closes BEFORE the step-up modal opens, so the
          two never stack (modal depth stays one). */}
      <Dialog
        onOpenChange={(open) => {
          if (!open && phase === "confirming") {
            abort();
          }
        }}
        open={phase === "confirming"}
      >
        <DialogContent data-testid="erasure-confirm">
          <DialogHeader>
            <DialogTitle>{t("dataRights.erasure.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("dataRights.erasure.confirmBody")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={abort} type="button" variant="outline">
              {t("dataRights.erasure.cancel")}
            </Button>
            <Button
              onClick={() => runErase()}
              type="button"
              variant="destructive"
            >
              {t("dataRights.erasure.confirmCta")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The per-action step-up modal (a plain single overlay, not a nested Dialog).
          Confirm resumes the erasure with the fresh credential; cancel aborts ONLY the
          action. Rendered ONLY while stepping up, so it never coexists with the confirm
          dialog. */}
      {phase === "stepping-up" ? (
        <StepUpModal
          failed={failed > 0}
          onCancel={abort}
          onConfirm={(credential) => runErase(credential)}
        />
      ) : null}

      {/* The POLITE live region: the erasure-recorded confirmation and any error are
          announced here without stealing focus. */}
      <div
        aria-live="polite"
        className="min-h-6 text-sm"
        data-testid="data-erasure-status"
        role="status"
      >
        {phase === "pending" ? (
          <span>{t("dataRights.erasure.pending")}</span>
        ) : null}
        {phase === "done" ? (
          <span>{t("dataRights.erasure.requested")}</span>
        ) : null}
        {phase === "error" ? (
          <span className="text-destructive">
            {t("dataRights.erasure.error")}
          </span>
        ) : null}
      </div>
    </section>
  );
}
