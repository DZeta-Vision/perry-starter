import { createFileRoute } from "@tanstack/react-router";

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

function RouteComponent() {
  const trpc = useTRPCClient();

  // The one-click export seam: the self-scoped export procedure derives the subject
  // from the session server-side — the client sends NO subject id. The live
  // owner-scoped read runs on the gatekeeper Worker surface (the sole SurrealDB
  // holder); the relay tier fails closed, surfacing the polite error state.
  const onExport = () => trpc.compliance.exportMyData.query({});

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 p-6">
      <h1 className="font-bold text-2xl">
        {tDataRights(LOCALE, "dataRights.title")}
      </h1>
      <DataExportPanel locale={LOCALE} onExport={onExport} />
    </div>
  );
}
