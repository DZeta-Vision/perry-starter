// The data seam interface — the single, target-agnostic contract that both the
// local-sidecar and cloud-relay implementations satisfy. Application, UI, and
// auth code depend only on this interface, never on a concrete implementation,
// and there is no runtime branch on the build target.
//
// Pluggable alternatives: the default store is SurrealDB (driven over HTTP). A
// node:sqlite-backed store and an Electric + Postgres store (browser-tier only)
// are documented alternative backings that can satisfy this same seam; SurrealDB
// is the default for the desktop/local tier.

// A stored document as it round-trips through the store. Field names are
// snake_case to match the canonical record shape and the underlying schema.
export interface DocumentRecord {
  readonly body_preview: string;
  readonly created_at: string;
  readonly id: string;
  readonly title: string;
  readonly updated_at: string;
}

export interface DocumentCreateInput {
  readonly body_preview?: string;
  readonly title: string;
}

export interface DocumentUpdateInput {
  readonly body_preview?: string;
  readonly title?: string;
}

// The uniform CRUD + keyset-list seam. The contract is identical whether backed
// by a local sidecar or a cloud endpoint.
export interface DocumentsDataSeam {
  create(input: DocumentCreateInput): Promise<DocumentRecord>;
  delete(id: string): Promise<void>;
  list(): Promise<readonly DocumentRecord[]>;
  read(id: string): Promise<DocumentRecord>;
  update(id: string, patch: DocumentUpdateInput): Promise<DocumentRecord>;
}
