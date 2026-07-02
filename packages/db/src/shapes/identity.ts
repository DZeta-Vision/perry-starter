import { z } from "zod";

// Canonical, single-sourced identity Zod shapes. Every consumer (auth, api,
// data-seam) imports these and never redeclares them, so the auth authority,
// the wire and the store cannot drift.

// The supported locales (FR/EN) with 'en' as the default. `.parse(undefined)`
// resolves to 'en'; any locale outside fr/en is rejected.
export const localeSchema = z.enum(["en", "fr"]).default("en");

// The resolved default locale, single-sourced for the better-auth
// additionalFields config so the auth tier never hard-codes its own default.
export const LOCALE_DEFAULT = "en" as const;

// The user model's single-sourced additionalFields: a constrained locale plus
// the given/family name parts. A missing name part is rejected.
export const userAdditionalFields = z.object({
  locale: localeSchema,
  given_name: z.string().min(1),
  family_name: z.string().min(1),
});

// The GLOBAL application authorization tier (admin-plugin `user.role`): a single
// hierarchy member < admin < superadmin. This is ORTHOGONAL to the
// organization-structural role (`owner`/`admin`/`member`) — `owner` is never a
// GLOBAL app-authz role.
export const appRoleSchema = z.enum(["member", "admin", "superadmin"]);

export const APP_ROLE_RANK = {
  member: 0,
  admin: 1,
  superadmin: 2,
} as const;

export type AppRole = z.infer<typeof appRoleSchema>;

// The single-sourced account status. A deactivate is a SOFT, reversible flip to
// `deactivated` (never a hard delete); a reactivate flips it back to `active`.
// This field lives HERE and nowhere else — every consumer (the admin surface,
// the sealed-`user` column, the list projection) imports it, so the
// active/deactivated state cannot fork across the wire, the store, and the UI.
export const userStatusSchema = z.enum(["active", "deactivated"]);

// The resolved default status, single-sourced so a fresh account is active and
// the sealed-table column default agrees with the shape.
export const USER_STATUS_DEFAULT = "active" as const;

export type UserStatus = z.infer<typeof userStatusSchema>;

// The canonical persisted user row. `role` is the GLOBAL app-authz role; `status`
// is the reversible-deactivate state; the additionalFields ride alongside the
// core identity columns. A row minted before the status column existed parses as
// `active` (the default), so the field is additive and never rejects a legacy row.
export const userSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  emailVerified: z.boolean(),
  name: z.string().optional(),
  role: appRoleSchema,
  status: userStatusSchema.default(USER_STATUS_DEFAULT),
  locale: localeSchema,
  given_name: z.string().min(1),
  family_name: z.string().min(1),
});

export type User = z.infer<typeof userSchema>;

// The canonical persisted organization row.
export const organizationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
});

export type Organization = z.infer<typeof organizationSchema>;

// The canonical persisted membership row. The org-structural `role` is a
// comma-separated STRING ("admin,member"), never an array column or join table —
// the auth tier splits it back into component roles.
export const memberSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  organizationId: z.string().min(1),
  role: z.string().min(1),
});

export type Member = z.infer<typeof memberSchema>;
