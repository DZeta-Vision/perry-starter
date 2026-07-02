import { z } from "zod";
import { isoTimestamp } from "../primitives";
import { appRoleSchema } from "./identity";

// The ONE canonical pending-invitation shape — single-sourced here so the auth
// authority, the wire, and the store cannot drift, and so a future
// organization-membership invitation reuses this same record rather than forking a
// second model. An org-membership invite is the SAME row with `organization_id`
// set and an org-structural role, driven through the same mint → email → accept →
// provision lifecycle.
//
// The account is provisioned ONLY on acceptance: an invitation row NEVER carries a
// user account, so no half-formed privileged account exists before acceptance. The
// privileged role rides here as the role to STAMP on acceptance — never stamped at
// invite time.

// The lifecycle states: pending → accepted | expired | revoked. A fresh invitation
// starts pending; acceptance, revocation, and auto-expiry are the three terminal
// transitions.
export const invitationStatusSchema = z.enum([
  "pending",
  "accepted",
  "expired",
  "revoked",
]);

// The resolved default status, single-sourced so a freshly issued invitation is
// pending and the sealed-table column default agrees with the shape.
export const INVITATION_STATUS_DEFAULT = "pending" as const;

export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

// The canonical persisted invitation row. `token_hash` is the digest of the
// single-use high-entropy token (never the plaintext token). `role` is the GLOBAL
// app-authz role to stamp on acceptance; `organization_id` is optional so an
// org-membership invitation reuses the same table. `accepted_at` is the single-use
// spend anchor: null until the invitation is accepted, so a replayed token resolves
// to consumed. strictObject pins the exact shape so a plaintext-token field can
// never be added by drift.
export const invitationSchema = z.strictObject({
  email: z.email(),
  organization_id: z.string().min(1).nullable(),
  role: appRoleSchema,
  token_hash: z.string().min(1),
  invited_by: z.string().min(1),
  status: invitationStatusSchema,
  created_at: isoTimestamp,
  expires_at: isoTimestamp,
  accepted_at: z.string().nullable(),
});

export type Invitation = z.infer<typeof invitationSchema>;
