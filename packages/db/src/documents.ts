import { z } from "zod";
import { scopeUserId, ulidId } from "./primitives";

// Domain-neutral reference entity. Removable-by-construction: nothing outside
// this module and its single collaboration-mode registry entry hard-codes the
// collection. The projected fields are generic snake_case (no domain nouns), and
// strictObject rejects any domain-coupled field appended to the shape.
export const documentsEntitySchema = z.strictObject({
  doc_id: ulidId,
  scope_user_id: scopeUserId,
  title: z.string(),
  body_preview: z.string(),
});

export type DocumentsEntity = z.infer<typeof documentsEntitySchema>;
