import { z } from "zod";
import { appRoleSchema, localeSchema } from "./identity";

// The canonical session-establishment payload. better-auth does NOT project
// custom additionalFields into its getSession payload by default; the auth tier
// closes that gap with a single-sourced projection, and this shape is the
// contract that projection must satisfy — it REQUIRES the projected identity
// fields (locale/given_name/family_name) alongside the GLOBAL role and the
// active organization, so a payload that drops any of them is rejected.
export const sessionPayloadSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  role: appRoleSchema,
  activeOrganizationId: z.string().min(1),
  locale: localeSchema,
  given_name: z.string().min(1),
  family_name: z.string().min(1),
});

export type SessionPayload = z.infer<typeof sessionPayloadSchema>;
