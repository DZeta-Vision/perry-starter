import type { DocumentRecord, DocumentsDataSeam } from "./documents";

// Cloud-relay implementation of the data seam. A stub for now: the concrete
// store over the cloud Worker gatekeeper lands later. It satisfies the
// identical interface so no application logic forks between targets.
const NOT_IMPLEMENTED =
  "documents data seam (cloud-relay) is not implemented yet";

export const documentsData = {
  get(): Promise<DocumentRecord | null> {
    throw new Error(NOT_IMPLEMENTED);
  },
  list(): Promise<readonly DocumentRecord[]> {
    throw new Error(NOT_IMPLEMENTED);
  },
} satisfies DocumentsDataSeam;

// Resolution sentinel: tells the build-time seam which implementation resolved.
export const __IMPL__ = "cloud" as const;
