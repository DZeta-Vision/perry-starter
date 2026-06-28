import type { DocumentRecord, DocumentsDataSeam } from "./documents";

// Local-sidecar implementation of the data seam. A stub for now: the concrete
// store over local SurrealDB-over-HTTP lands later. It exists so the
// build-time seam can select a physically distinct module per target.
const NOT_IMPLEMENTED =
  "documents data seam (local-sidecar) is not implemented yet";

export const documentsData = {
  get(): Promise<DocumentRecord | null> {
    throw new Error(NOT_IMPLEMENTED);
  },
  list(): Promise<readonly DocumentRecord[]> {
    throw new Error(NOT_IMPLEMENTED);
  },
} satisfies DocumentsDataSeam;

// Resolution sentinel: tells the build-time seam which implementation resolved.
export const __IMPL__ = "local" as const;
