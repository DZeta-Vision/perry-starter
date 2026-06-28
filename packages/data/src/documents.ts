// The data seam interface — the single, target-agnostic contract that both the
// local-sidecar and cloud-relay implementations satisfy. This is shape-only for
// now: a minimal, self-contained representative method set. The concrete CRUD
// over the canonical document shapes lands later; do not forward-
// import canonical shapes that do not exist yet.

// A minimal, self-contained reference to a stored document. The canonical
// document shapes are owned by the db tier and arrive later.
export interface DocumentRef {
  readonly id: string;
  readonly scopeUserId: string;
}

export interface DocumentRecord extends DocumentRef {
  readonly updatedCursor: number;
}

// The uniform data seam. The contract is identical whether backed by a local
// sidecar or a cloud endpoint — application/UI/auth code depends only on this
// interface, never on a concrete implementation.
export interface DocumentsDataSeam {
  get(ref: DocumentRef): Promise<DocumentRecord | null>;
  list(scopeUserId: string): Promise<readonly DocumentRecord[]>;
}
