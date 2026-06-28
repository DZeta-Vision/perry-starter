import { z } from "zod";
import {
  base64Payload,
  scopeUserId,
  serverCursor,
  ulidId,
} from "../primitives";

// The durable / stored / acked delta envelope. `cursor` is the server-assigned
// integer (present once acked); pre-push and per-id ack variants derive from
// this shape downstream and never relax it. strictObject rejects any drift.
export const deltaEnvelopeSchema = z.strictObject({
  id: ulidId,
  scope_user_id: scopeUserId,
  doc_id: ulidId,
  doc_schema_version: z.number().int().nonnegative(),
  cursor: serverCursor,
  payload: base64Payload,
});

export type DeltaEnvelope = z.infer<typeof deltaEnvelopeSchema>;
