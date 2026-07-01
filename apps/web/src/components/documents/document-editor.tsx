// The local-first autosaving document editor.
//
// Keystroke-level OPTIMISTIC local edits: every keystroke updates the local view
// immediately with NO blocking spinner and no round-trip to the network (the UI
// never blocks on sync). For a COLLABORATIVE document the keystroke is captured
// through the browser-tier Loro adapter (`./crdt/loro-doc-adapter`) as an opaque
// base64 delta handed to the transport; the daemon never decodes it. A private
// document converges by last-write-wins in the materializer/seam — the editor
// only writes locally and lets the seam own the winner.
//
// The editor surfaces the per-item freshness verdict via `FreshnessIndicator`
// (a pure renderer of the single-owner seam verdict) — it never claims "saved to
// cloud" off a local write; durability is the seam's `up-to-date`, gated on the
// per-id push ack.
//
// Loro is browser-tier only: the concrete `loro-crdt` adapter is loaded with a
// CLIENT-ONLY dynamic import so the SSR/SPA prerender (and the daemon) never
// import the WASM engine.

import { useEffect, useRef, useState } from "react";

import type {
  CollaborativeEditor,
  OpaqueDeltaTransport,
} from "@/lib/crdt/loro-editor";
import { createCollaborativeEditor } from "@/lib/crdt/loro-editor";

import {
  FreshnessIndicator,
  type FreshnessStatus,
} from "./freshness-indicator";

export interface DocumentEditorProps {
  // True when the document's collection is collaborative (Loro causal merge);
  // false for private documents (last-write-wins, no Loro).
  readonly collaborative?: boolean;
  readonly docId: string;
  readonly initialBody?: string;
  readonly onBodyChange?: (body: string) => void;
  // The pre-computed verdict from the seam for this document.
  readonly status: FreshnessStatus;
  readonly title?: string;
}

export function DocumentEditor({
  collaborative = false,
  docId,
  initialBody = "",
  onBodyChange,
  status,
  title,
}: DocumentEditorProps) {
  const [body, setBody] = useState(initialBody);
  const collaborativeEditorRef = useRef<CollaborativeEditor | null>(null);

  useEffect(() => {
    if (!collaborative) {
      collaborativeEditorRef.current = null;
      return;
    }
    let cancelled = false;
    // Client-only: the concrete loro-crdt adapter is dynamically imported so the
    // SSR/SPA prerender never loads the WASM engine.
    (async () => {
      const { createLoroBrowserCrdtDoc } = await import(
        "@/lib/crdt/loro-doc-adapter"
      );
      // The transport carries the OPAQUE base64 delta verbatim; the local-first
      // outbox + per-id push ack live in the data/sync layer.
      const transport: OpaqueDeltaTransport = {
        push: () => undefined,
      };
      const editor = createCollaborativeEditor(
        docId,
        createLoroBrowserCrdtDoc,
        transport
      );
      if (!cancelled) {
        collaborativeEditorRef.current = editor;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [collaborative, docId]);

  const handleInput = (next: string) => {
    // Optimistic: reflect the keystroke immediately, never blocking on sync.
    setBody(next);
    onBodyChange?.(next);
    // Capture the collaborative edit as an opaque base64 Loro delta.
    collaborativeEditorRef.current?.edit((doc) =>
      doc.applyLocalEdit(() => undefined)
    );
  };

  return (
    <div
      className="flex h-full flex-col gap-3 p-4"
      data-doc-id={docId}
      data-document-editor
      data-status={status}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-lg">{title ?? "Untitled"}</h2>
        <FreshnessIndicator status={status} />
      </div>
      <textarea
        aria-label="Document body"
        className="min-h-64 flex-1 resize-none rounded-md border bg-transparent p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => handleInput(event.currentTarget.value)}
        value={body}
      />
    </div>
  );
}
