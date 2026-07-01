// The embedding half of the AI seam. The projection's single writer CALLS this
// to compute a document's embedding vector; the seam itself never writes the
// projection table (single-writer rule). The result is model-tagged so a single
// vector index never mixes embedding spaces (a local-model vector is not
// interchangeable with a cloud-model vector).
//
// The real embedding model is spike-gated / ship-independent. This stub is the
// P0 path: a deterministic, fixed-dimension, model-tagged vector — same text →
// same vector, so RAG retrieval is testable end-to-end without the real model.

export interface EmbeddingResult {
  readonly model: string;
  readonly vector: readonly number[];
}

export const STUB_EMBED_MODEL = "stub-embed-v0";
export const STUB_EMBED_DIM = 8;

const HASH_MODULUS = 1000;
const HASH_MULTIPLIER = 31;

export const stubEmbed = (text: string): EmbeddingResult => {
  const vector = Array.from({ length: STUB_EMBED_DIM }, (_unused, index) => {
    let hash = index + 1;
    for (const char of text) {
      hash = (hash * HASH_MULTIPLIER + char.charCodeAt(0)) % HASH_MODULUS;
    }
    return hash / HASH_MODULUS;
  });
  return { model: STUB_EMBED_MODEL, vector };
};
