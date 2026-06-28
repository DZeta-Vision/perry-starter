import { z } from "zod";
import { isoTimestamp, ulidId } from "./primitives";

// Canonical hand-authored Zod shape for a stored `documents` record as it
// round-trips over the data store. The id is a client-minted ULID; the
// timestamps are server-generated ISO-8601 strings. Field names are snake_case
// to match the schema fields exactly, so the store and the validator cannot
// drift. strictObject rejects any extra field appended to a returned record.
export const documentSchema = z.strictObject({
  id: ulidId,
  title: z.string(),
  body_preview: z.string(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});

export type Document = z.infer<typeof documentSchema>;
