import type { DocumentProjection } from "@perry-starter/db/shapes/document-projection";

// SurrealDB vector/RAG over the local document-embedding projection.
//
// The single projection writer computes a document's embedding via the AI-seam
// `embed` interface (passed in as a function — the AI seam never writes the
// table) and writes it into the sealed `document_projection` table. RAG
// retrieval is a SurrealDB-native HNSW KNN search: index-backed and
// keyset-bounded (scoped by the server-derived userId), never a full-collection
// client scan and never OFFSET. The same dialect serves server-side retrieval in
// the cloud tier. Reads run over loopback HTTP fetch (the daemon never imports an
// in-process engine); this module is the pure SQL + validation core.

export const PROJECTION_TABLE = "document_projection";

// The stub embedding-space dimension. It MUST match packages/ai's STUB_EMBED_DIM
// and the `document_projection.embedding` HNSW index DIMENSION in the schema — a
// single index never mixes embedding spaces, so the dimension is fixed per model.
export const EMBEDDING_DIM = 8;

// Model tags that mean "not embedded yet" — never valid for a real vector.
const SENTINEL_MODEL_TAGS = new Set(["unembedded", "unset", ""]);

// d79: validate the embedding output before it is written. A real embedding is a
// finite-valued vector of the index dimension, tagged with a real (non-sentinel)
// model. A malformed vector or a sentinel tag throws rather than poisoning the
// index.
export const validateEmbedding = (
  vector: readonly number[],
  model: string
): void => {
  if (SENTINEL_MODEL_TAGS.has(model)) {
    throw new Error(
      `embedding model tag "${model}" is a sentinel, not a real model`
    );
  }
  if (vector.length !== EMBEDDING_DIM) {
    throw new Error(
      `embedding dimension ${vector.length} != index dimension ${EMBEDDING_DIM}`
    );
  }
  if (!vector.every((value) => Number.isFinite(value))) {
    throw new Error("embedding vector contains a non-finite value");
  }
};

// The text the projection writer embeds for a document (title + preview).
export const embeddableText = (projection: DocumentProjection): string =>
  `${projection.title}\n${projection.body_preview}`.trim();

// The projection writer fills the embedding column by CALLING the AI-seam embed
// interface and validating the result — the AI seam never writes the table. The
// returned projection carries the filled, validated, model-tagged embedding.
export const fillEmbedding = async (
  base: DocumentProjection,
  embed: (text: string) => Promise<{
    readonly model: string;
    readonly vector: readonly number[];
  }>
): Promise<DocumentProjection> => {
  const { model, vector } = await embed(embeddableText(base));
  validateEmbedding(vector, model);
  return { ...base, embedding: [...vector], embedding_model: model };
};

// d76: the projection `.surql` write path — an idempotent UPSERT of the
// materialized row keyed by (scope_user_id, doc_id). Values are $-bound (never
// spliced into the query body).
export const buildProjectionUpsertSql = (): string =>
  `UPSERT type::thing($tb, [$scope, $doc]) CONTENT {
  scope_user_id: $scope,
  doc_id: $doc,
  title: $title,
  body_preview: $preview,
  embedding: $embedding,
  embedding_model: $model,
  updated_cursor: $cursor
} RETURN NONE;`;

// The RAG retrieval query: a SurrealDB-native HNSW KNN top-k over the scope's
// embeddings. Index-backed via the HNSW `<|K,EF|>` operator; keyset-bounded by
// the server-derived scope; filtered to the one model's embedding space. NO
// OFFSET and no full-collection client scan. `k`/`ef` are validated integers
// spliced as numeric literals (the operator's arity is syntax, not a bind value);
// `$scope`, `$model`, `$query` are $-bound.
export const buildKnnRetrievalSql = (k: number, ef = 40): string => {
  const topK = Math.max(1, Math.trunc(k));
  const efSearch = Math.max(topK, Math.trunc(ef));
  return `SELECT doc_id, title, body_preview, vector::distance::knn() AS dist
FROM ${PROJECTION_TABLE}
WHERE scope_user_id = $scope
  AND embedding_model = $model
  AND embedding <|${topK},${efSearch}|> $query
ORDER BY dist ASC;`;
};

// Read-path guard: a RAG read must be index-backed (the HNSW `<|K,EF|>` operator),
// keyset-bounded by the scope, and free of OFFSET / full-collection scan.
const HNSW_OPERATOR = /<\|\d+\s*,\s*\d+\|>/;
const SCOPE_FILTER = /where[\s\S]*\bscope_user_id\s*=\s*\$scope/i;
const OFFSET = /\boffset\b/i;

export const isIndexBackedKeysetRead = (query: string): boolean =>
  HNSW_OPERATOR.test(query) && SCOPE_FILTER.test(query) && !OFFSET.test(query);
