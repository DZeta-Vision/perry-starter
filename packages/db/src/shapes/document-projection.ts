import { z } from "zod";
import { scopeUserId, serverCursor, ulidId } from "../primitives";

// The read-model projection. A single owning writer (the browser projection
// writer) owns every column including the embedding; the AI seam computes
// embeddings through its interface but never writes this table. The embedding is
// model-tagged so a single index never mixes embedding spaces (a local-model
// vector is not interchangeable with a cloud-model vector). `updated_cursor` is
// the server-assigned integer.
export const documentProjectionSchema = z.strictObject({
  doc_id: ulidId,
  scope_user_id: scopeUserId,
  title: z.string(),
  body_preview: z.string(),
  embedding: z.array(z.number()).nullable(),
  embedding_model: z.string().min(1),
  updated_cursor: serverCursor,
});

export type DocumentProjection = z.infer<typeof documentProjectionSchema>;
