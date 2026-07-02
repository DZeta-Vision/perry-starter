import { createFileRoute } from "@tanstack/react-router";

import type { ErasureOutcome } from "@/components/settings/data-erasure-panel";
import { DataErasurePanel } from "@/components/settings/data-erasure-panel";
import { DataExportPanel } from "@/components/settings/data-export-panel";
import { tDataRights } from "@/lib/data-rights-strings";
import { useTRPCClient } from "@/utils/trpc";

export const Route = createFileRoute("/settings/data")({
  component: RouteComponent,
});

// The active locale store lands with the i18n floor in a later epic; until then the
// surface renders in the EN catalog (the hand-rolled EN/FR catalog is already in
// place, so the switch is a one-line change, not a rewrite).
const LOCALE = "en" as const;

const dataCodeOf = (error: unknown): string | undefined => {
  const shape = (error as { data?: { code?: string } } | undefined)?.data;
  return shape?.code;
};

function RouteComponent() {
  const trpc = useTRPCClient();

  // The one-click export seam: the self-scoped export procedure derives the subject
  // from the session server-side — the client sends NO subject id. The live
  // owner-scoped read runs on the gatekeeper Worker surface (the sole SurrealDB
  // holder); the relay tier fails closed, surfacing the polite error state.
  const onExport = () => trpc.compliance.exportMyData.query({});

  // The erasure seam: the self-scoped, step-up-guarded erasure mutation. The FIRST
  // call carries no grant, so the server challenges (STEP_UP_REQUIRED) → the panel
  // raises the step-up modal; the re-auth credential mints a fresh grant bound to the
  // erasure action (threaded on the step-up header), and the resume soft-deletes +
  // registers + audits. A cancel aborts only the action, never the session.
  const onErase = async (stepUp?: {
    readonly credential: string;
  }): Promise<ErasureOutcome> => {
    try {
      await trpc.erasure.requestErasure.mutate(undefined, {
        context: stepUp ? { stepUpCredential: stepUp.credential } : undefined,
      });
      return { status: "done" };
    } catch (error) {
      // The step-up gate rides STEP_UP_REQUIRED in shape.data.code (it is not a native
      // tRPC code). The FIRST call carries no grant, so the server challenges with it —
      // the panel then raises the step-up modal.
      if (dataCodeOf(error) === "STEP_UP_REQUIRED") {
        return { status: "step-up-required" };
      }
      throw error;
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 p-6">
      <h1 className="font-bold text-2xl">
        {tDataRights(LOCALE, "dataRights.title")}
      </h1>
      <DataExportPanel locale={LOCALE} onExport={onExport} />
      <DataErasurePanel locale={LOCALE} onErase={onErase} />
    </div>
  );
}
