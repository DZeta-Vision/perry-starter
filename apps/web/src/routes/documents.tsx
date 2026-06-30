// The /documents route — the user-facing realization of the offline-first sync
// substrate (Flow 2). It composes the virtualized keyset list, the local-first
// editor, and the freshness + offline indicators, and wires the connectivity
// subscriber that fires the single transition toast.
//
// Freshness verdicts arrive as OPAQUE DATA from the single-owner data/sync seam
// (`attachSyncStatus`): the seam derives each document's verdict and hands the
// UI only the `syncStatus` string. The UI never derives a verdict and never
// touches the raw cursors, so `up-to-date` can only appear once the seam reports
// the per-id push ack has landed (never a false "saved to cloud").

import {
  attachSyncStatus,
  type WithSyncStatus,
} from "@perry-starter/sync/sync-status-view";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { DocumentEditor } from "@/components/documents/document-editor";
import {
  DocumentList,
  type DocumentRow,
} from "@/components/documents/document-list";
import { OfflineIndicator } from "@/components/documents/offline-indicator";
import {
  useConnectivitySubscriber,
  useOfflineStore,
} from "@/lib/offline-store";

export const Route = createFileRoute("/documents")({
  component: DocumentsRoute,
});

// The UI-facing document shape — presentation fields only. The sync verdict is
// NOT seeded here: it is attached by the seam (`attachSyncStatus`), which owns
// the cursor inputs and the derive. The UI only ever reads the opaque verdict.
interface SeedDocument {
  readonly bodyPreview: string;
  readonly collaborative: boolean;
  readonly docId: string;
  readonly title: string;
}

const SEED_DOCUMENTS: readonly SeedDocument[] = [
  {
    docId: "edited-doc",
    title: "Quarterly plan",
    bodyPreview: "Durable and recent — the seam reports up to date.",
    collaborative: false,
  },
  {
    docId: "collab-doc",
    title: "Shared design notes",
    bodyPreview:
      "Collaborative with no materializing tab — honestly may be stale.",
    collaborative: true,
  },
  {
    docId: "private-doc",
    title: "Personal journal",
    bodyPreview: "Private, last-write-wins — converges with no merge dialog.",
    collaborative: false,
  },
];

function DocumentsRoute() {
  useConnectivitySubscriber();
  const online = useOfflineStore((state) => state.online);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Verdict-as-data: the seam attaches the opaque `syncStatus` verdict; the UI
  // renders it and never re-derives it.
  const documents: WithSyncStatus<SeedDocument>[] = useMemo(
    () => attachSyncStatus(SEED_DOCUMENTS),
    []
  );

  const rows: DocumentRow[] = useMemo(
    () =>
      documents.map((document) => ({
        id: document.docId,
        title: document.title,
        bodyPreview: document.bodyPreview,
        status: document.syncStatus,
      })),
    [documents]
  );

  const selected = useMemo(
    () => documents.find((document) => document.docId === selectedId),
    [documents, selectedId]
  );

  return (
    <div className="grid h-full grid-cols-[minmax(280px,360px)_1fr] overflow-hidden">
      <aside className="flex min-h-0 flex-col border-r">
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <h1 className="font-semibold text-base">Documents</h1>
          <OfflineIndicator online={online} />
        </header>
        <div className="min-h-0 flex-1">
          <DocumentList
            onCreateDocument={() => setSelectedId(null)}
            onOpenDocument={setSelectedId}
            rows={rows}
            totalCount={rows.length}
          />
        </div>
      </aside>
      <section className="min-h-0 overflow-auto">
        {selected ? (
          <DocumentEditor
            collaborative={selected.collaborative}
            docId={selected.docId}
            initialBody={selected.bodyPreview}
            key={selected.docId}
            status={selected.syncStatus}
            title={selected.title}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-muted-foreground text-sm">
            Select a document to start editing.
          </div>
        )}
      </section>
    </div>
  );
}
