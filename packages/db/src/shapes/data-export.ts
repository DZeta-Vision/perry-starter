import { z } from "zod";
import { isoTimestamp, scopeUserId, ulidId } from "../primitives";
import { auditEntrySchema } from "./audit-entry";
import { deltaEnvelopeSchema } from "./delta-envelope";
import {
  appRoleSchema,
  localeSchema,
  USER_STATUS_DEFAULT,
  userStatusSchema,
} from "./identity";

// The canonical, single-sourced GDPR data-export bundle. Every consumer
// — the export procedure that assembles it, the export sink that reads it, and the
// web surface that downloads it — imports THIS shape and never redeclares it, so
// the machine-readable dump cannot drift across the wire and the store.
//
// Every collection is an ARRAY keyed to the requesting subject: the profile row's
// own id, the document/delta `scope_user_id`, and the audit entry's `actor` all
// equal the server-derived subject id. This uniform owner-keying is what the
// cross-scope isolation guard checks — a bundle carrying ANY row whose owner key
// differs from `subject_user_id` is a leak.

// The exported profile row (the subject's own identity), projected to the
// non-sensitive identity columns. `id` is the bare subject key (the export mapper
// strips the `user:` record prefix), so it equals `subject_user_id`.
export const exportedProfileSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  locale: localeSchema,
  given_name: z.string().min(1),
  family_name: z.string().min(1),
  role: appRoleSchema,
  status: userStatusSchema.default(USER_STATUS_DEFAULT),
});

export type ExportedProfile = z.infer<typeof exportedProfileSchema>;

// The exported document row (read from the durable, owner-scoped read model). This
// shape is single-sourced HERE — decoupled from any domain-specific reference
// entity — and keyed to the subject by `scope_user_id`.
export const exportedDocumentSchema = z.strictObject({
  doc_id: ulidId,
  scope_user_id: scopeUserId,
  title: z.string(),
  body_preview: z.string(),
});

export type ExportedDocument = z.infer<typeof exportedDocumentSchema>;

// The owned collections the export sink reads (before the envelope fields are
// stamped). strictObject rejects any drift.
export const dataExportCollectionsSchema = z.strictObject({
  profile: z.array(exportedProfileSchema),
  documents: z.array(exportedDocumentSchema),
  deltas: z.array(deltaEnvelopeSchema),
  audit_trail: z.array(auditEntrySchema),
});

export type DataExportCollections = z.infer<typeof dataExportCollectionsSchema>;

// The full machine-readable dump: the server-stamped envelope (`exported_at` +
// the server-derived `subject_user_id`) plus the subject's owned collections.
export const dataExportBundleSchema = z.strictObject({
  exported_at: isoTimestamp,
  subject_user_id: scopeUserId,
  profile: z.array(exportedProfileSchema),
  documents: z.array(exportedDocumentSchema),
  deltas: z.array(deltaEnvelopeSchema),
  audit_trail: z.array(auditEntrySchema),
});

export type DataExportBundle = z.infer<typeof dataExportBundleSchema>;
