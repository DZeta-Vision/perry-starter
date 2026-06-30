// The virtualized, keyset-backed documents list.
//
// Rendered over `@tanstack/react-virtual` (`useVirtualizer`) reading a server
// keyset query (never OFFSET), with `getItemKey` returning the server row ULID
// (never the array index) so the measurement cache + React reconciliation stay
// correct as keyset pages append. The list exposes its set size via
// `aria-rowcount` / `aria-setsize` (= the SERVER total, not the windowed count),
// announces "loaded N more" through a polite live region on keyset append, and
// never loses or traps keyboard focus on recycled rows. A row click opens the
// editor; the per-row actions (open, delete) reveal on hover AND `:focus-within`
// (never hover-only) and stay tap-reachable at the >=24px target. The empty
// state reads the generic placeholder copy with a single primary action; the
// cold load renders skeleton rows matching the layout.
//
// Virtualization uses the native-table spacer technique (leading/trailing spacer
// rows around the windowed rows) so the list keeps real table semantics — a
// genuine accessible data table, not a generic-div grid that loses its roles.

import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import {
  FreshnessIndicator,
  type FreshnessStatus,
} from "./freshness-indicator";

export interface DocumentRow {
  readonly bodyPreview: string;
  readonly id: string;
  // The per-item verdict, carried from the seam for the row's freshness chip.
  readonly status: FreshnessStatus;
  readonly title: string;
}

export interface DocumentListProps {
  // True during the cold load — renders skeleton rows matching the layout.
  readonly loading?: boolean;
  readonly onCreateDocument?: () => void;
  readonly onDeleteDocument?: (id: string) => void;
  readonly onOpenDocument?: (id: string) => void;
  readonly rows: readonly DocumentRow[];
  // The server total — the source of truth for `aria-rowcount` / `aria-setsize`.
  readonly totalCount: number;
}

const ROW_ESTIMATE_PX = 64;
// A bounded overscan keeps DOM node count O(viewport); it never re-inflates
// toward O(list).
const ROW_OVERSCAN = 10;
const SKELETON_ROW_COUNT = 6;

const EMPTY_PLACEHOLDER = "Nothing here yet. Create your first document.";

function ColdLoadSkeleton() {
  return (
    <div className="space-y-2 p-2" data-document-list-skeleton>
      {Array.from({ length: SKELETON_ROW_COUNT }, (_value, index) => (
        <Skeleton
          className="h-14 w-full rounded-md"
          key={`skeleton-${index.toString()}`}
        />
      ))}
    </div>
  );
}

function EmptyState({ onCreateDocument }: { onCreateDocument?: () => void }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-4 p-12 text-center"
      data-document-list-empty
    >
      <p className="text-muted-foreground">{EMPTY_PLACEHOLDER}</p>
      <button
        className="inline-flex h-9 items-center rounded-md bg-foreground px-4 font-medium text-background text-sm"
        onClick={() => onCreateDocument?.()}
        type="button"
      >
        New document
      </button>
    </div>
  );
}

function DocumentRowCells({
  onDeleteDocument,
  onOpenDocument,
  row,
}: {
  onDeleteDocument?: (id: string) => void;
  onOpenDocument?: (id: string) => void;
  row: DocumentRow;
}) {
  return (
    <td className="border-b p-0">
      <div className="group flex w-full items-center gap-3 px-3">
        <button
          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 py-2 text-left"
          onClick={() => onOpenDocument?.(row.id)}
          type="button"
        >
          <span className="truncate font-medium text-sm">{row.title}</span>
          <span className="truncate text-muted-foreground text-xs">
            {row.bodyPreview}
          </span>
        </button>
        <FreshnessIndicator status={row.status} />
        <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100">
          <button
            aria-label={`Open ${row.title}`}
            className="inline-flex h-8 min-w-8 items-center rounded-md px-2 text-sm hover:bg-accent"
            onClick={() => onOpenDocument?.(row.id)}
            type="button"
          >
            Open
          </button>
          <button
            aria-label={`Delete ${row.title}`}
            className="inline-flex h-8 min-w-8 items-center rounded-md px-2 text-destructive text-sm hover:bg-accent"
            onClick={() => onDeleteDocument?.(row.id)}
            type="button"
          >
            Delete
          </button>
        </div>
      </div>
    </td>
  );
}

export function DocumentList({
  loading = false,
  onCreateDocument,
  onDeleteDocument,
  onOpenDocument,
  rows,
  totalCount,
}: DocumentListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // The polite "loaded N more" announcement, recomputed when the keyset window
  // grows. Kept text-based so assistive tech hears the append politely.
  const [appendMessage, setAppendMessage] = useState("");
  const previousCount = useRef(rows.length);

  useEffect(() => {
    const grew = rows.length - previousCount.current;
    if (grew > 0) {
      setAppendMessage(`Loaded ${grew} more`);
    }
    previousCount.current = rows.length;
  }, [rows.length]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => ROW_ESTIMATE_PX,
    getItemKey: (index) => rows[index]?.id ?? index,
    getScrollElement: () => scrollRef.current,
    overscan: ROW_OVERSCAN,
  });

  if (loading) {
    return <ColdLoadSkeleton />;
  }

  if (rows.length === 0) {
    return <EmptyState onCreateDocument={onCreateDocument} />;
  }

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop =
    virtualItems.length > 0 ? (virtualItems[0]?.start ?? 0) : 0;
  const lastEnd = virtualItems.at(-1)?.end ?? 0;
  const paddingBottom =
    virtualItems.length > 0 ? Math.max(totalSize - lastEnd, 0) : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Polite live region — announces keyset appends without stealing focus. */}
      <div aria-live="polite" className="sr-only" role="status">
        {appendMessage}
      </div>
      <div className="min-h-0 flex-1 overflow-auto" ref={scrollRef}>
        {/* The padding wrapper reserves the off-window scroll space so only the
            windowed rows are materialized while native table semantics stay
            intact (no spacer rows, no aria-hidden). */}
        <div
          style={{
            paddingBottom: `${paddingBottom}px`,
            paddingTop: `${paddingTop}px`,
          }}
        >
          <table
            aria-label="Documents"
            aria-rowcount={totalCount}
            className="w-full border-collapse"
            data-document-list
          >
            <caption className="sr-only">Documents</caption>
            <tbody>
              {virtualItems.map((virtualItem) => {
                const row = rows[virtualItem.index];
                if (!row) {
                  return null;
                }
                return (
                  <tr
                    aria-rowindex={virtualItem.index + 1}
                    aria-setsize={totalCount}
                    data-doc-id={row.id}
                    data-document-row
                    key={virtualItem.key}
                    style={{ height: `${virtualItem.size}px` }}
                  >
                    <DocumentRowCells
                      onDeleteDocument={onDeleteDocument}
                      onOpenDocument={onOpenDocument}
                      row={row}
                    />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
