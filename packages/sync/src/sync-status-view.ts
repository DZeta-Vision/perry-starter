// Consumer-facing sync-status view — the seam's single exit for the verdict.
//
// The single-owner verdict (up-to-date / syncing / may-be-stale) is derived HERE
// in the seam tier and handed to consumers as an OPAQUE `SyncStatus` string
// attached to each document. The raw integer cursors the verdict is derived from
// never cross the tier boundary into the UI: the UI imports this mapper (and the
// verdict-as-data it returns), never the derive function and never the cursor
// fields — the single-owner contract realized as data flow.

import type { SyncStatus, SyncStatusReadModel } from "./sync-status";
import { deriveItemSyncStatus } from "./sync-status";

// A document carrying ONLY the opaque verdict string — the sole sync information
// that crosses into the UI tier. Consumers render `syncStatus`; they never see,
// assemble, or re-derive the underlying cursors.
export type WithSyncStatus<T> = T & { readonly syncStatus: SyncStatus };

// Reference read-model inputs for the bundled documents demo, keyed by doc id.
// In a wired app these are assembled in the data tier from the live outbox
// (unacked count), the push-response cursor (durability ack), the keyset pull
// (latest-known-server), and the projection materializer. They live HERE in the
// seam — never in the UI — so the raw cursors never cross the tier boundary. An
// unknown doc is treated as possibly-behind (never falsely up-to-date).
const REFERENCE_SYNC_READS: Readonly<Record<string, SyncStatusReadModel>> = {
  "edited-doc": {
    doc_id: "edited-doc",
    acked_cursor: 5,
    active_pull: false,
    collaborative: false,
    latest_known_server_cursor: 5,
    projection_cursor: null,
    unacked_count: 0,
    updated_cursor: 5,
  },
  "collab-doc": {
    doc_id: "collab-doc",
    acked_cursor: 5,
    active_pull: false,
    collaborative: true,
    latest_known_server_cursor: 8,
    projection_cursor: 5,
    unacked_count: 0,
    updated_cursor: 5,
  },
  "private-doc": {
    doc_id: "private-doc",
    acked_cursor: 9,
    active_pull: false,
    collaborative: false,
    latest_known_server_cursor: 9,
    projection_cursor: null,
    unacked_count: 0,
    updated_cursor: 9,
  },
};

// Attach the single-owner verdict to each document (keyed by `docId`). The
// derive runs here in the seam; consumers receive documents carrying only the
// opaque `syncStatus`. A document with no known read-model resolves to the
// truthful possibly-behind verdict — never a premature/false "saved to cloud".
export const attachSyncStatus = <T extends { readonly docId: string }>(
  docs: readonly T[]
): WithSyncStatus<T>[] =>
  docs.map((doc) => {
    const read = REFERENCE_SYNC_READS[doc.docId];
    return {
      ...doc,
      syncStatus: read ? deriveItemSyncStatus(read) : "may-be-stale",
    };
  });
