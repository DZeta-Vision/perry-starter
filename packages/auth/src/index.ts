import {
  APP_ROLE_RANK as APP_ROLE_RANK_SOURCE,
  appRoleSchema,
  LOCALE_DEFAULT,
  userAdditionalFields,
} from "@perry-starter/db/shapes/identity";
import { env } from "@perry-starter/env/server";
import { betterAuth } from "better-auth";
import {
  admin,
  bearer,
  customSession,
  jwt,
  organization,
} from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { surrealAdapter } from "./surreal-adapter";

// packages/auth is the SOLE authn/authz authority (AD-8). It imports ONLY
// packages/db (canonical identity shapes) and packages/env (the SURREAL_*/
// BETTER_AUTH_* contract) — never packages/api or packages/infra. The singleton
// runs ONLY on the apps/worker Cloudflare host; the browser calls it via
// better-auth/client and the Perry daemon forwards a bearer token + verifies the
// ES256 JWT offline. No other unit issues sessions or tokens.

// --- The single-sourced RBAC matrix (D3 / AD-9) -----------------------------

// THE matrix is built ONCE and the SAME `ac`/`roles` are passed to BOTH
// organization() and admin() so the in-process leg and the (later) SurrealDB
// row-level PERMISSIONS leg cannot drift. The GLOBAL application roles are a
// single hierarchy member < admin < superadmin, ORTHOGONAL to the
// organization-structural role (owner/admin/member).
const statement = {
  document: ["create", "read", "update", "delete"],
} as const;

export const ac = createAccessControl(statement);

export const roles = {
  member: ac.newRole({ document: ["read"] }),
  admin: ac.newRole({ document: ["create", "read", "update", "delete"] }),
  superadmin: ac.newRole({ document: ["create", "read", "update", "delete"] }),
};

// Re-exposed from the single-sourced db shape (member:0 < admin:1 < superadmin:2).
export const APP_ROLE_RANK = APP_ROLE_RANK_SOURCE;

// The org-structural `member.role` is persisted as a comma-separated STRING
// ("admin,member"). Split it back into component roles; treating it as one
// atomic value would break multi-role members.
export const parseMemberRoles = (roleString: string): string[] =>
  roleString
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role.length > 0);

// --- Session establishment + personal-org bootstrap (D1/D2) -----------------

// NOTE ON OWNERSHIP: the real personal organization is PROVISIONED at account
// registration (the user-creation flow, owned elsewhere). This module
// establishes only the session-RESOLUTION mechanism — given a user it derives
// the active organization and projects the canonical identity. The helpers here
// (personalOrgSeedFor / seedActiveOrganization) are the documented bootstrap
// seam that the registration provisioning hook satisfies, not the provisioning
// itself.

// The org-structural role of an organization's creator — DISTINCT from the
// GLOBAL app-authz roles (member/admin/superadmin).
const PERSONAL_ORG_CREATOR_ROLE = "owner";

const ORG_STRUCTURAL_ROLES = new Set(["owner", "admin", "member"]);

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

// Project the canonical identity fields into the session-establishment payload.
// SINGLE source fed to BOTH the jwt definePayload and the getSession projection,
// so locale/given_name/family_name survive alongside the GLOBAL role and the
// active organization instead of being silently dropped (the known better-auth
// additionalFields-not-in-getSession gap).
export const projectSessionFields = ({
  user,
  session,
}: {
  user: Record<string, unknown>;
  session: Record<string, unknown>;
}) => ({
  id: str(user.id),
  email: str(user.email),
  role: str(user.role) || "member",
  activeOrganizationId: str(session.activeOrganizationId),
  locale: str(user.locale) || LOCALE_DEFAULT,
  given_name: str(user.given_name),
  family_name: str(user.family_name),
});

// The getSession projection wired into the customSession plugin. better-auth's
// additionalFields are NOT surfaced through getSession by default (only the jwt
// definePayload was projecting them), so the relay middleware that reads the
// get-session body would drop locale/given_name/family_name. Fold the SAME
// projection over the get-session response so both legs carry the canonical
// identity, preserving the standard `{ user, session }` envelope.
export const projectGetSession = ({
  user,
  session,
}: {
  user: Record<string, unknown>;
  session: Record<string, unknown>;
}) => ({
  user,
  session,
  ...projectSessionFields({ user, session }),
});

// The seed for the personal organization auto-provisioned at account creation.
export const personalOrgSeedFor = (user: Record<string, unknown>) => {
  const ownerName = str(user.given_name) || "Personal";
  return {
    name: `${ownerName} Workspace`,
    slug: `personal-${str(user.id)}`,
    creatorRole: PERSONAL_ORG_CREATOR_ROLE,
  };
};

// Resolve the active organization for a fresh self-registered member: its
// auto-provisioned personal org (org-role owner). A non-empty active org means
// the bootstrap fired on the fresh session.
export const seedActiveOrganization = ({
  user,
}: {
  user: Record<string, unknown>;
}) => ({
  activeOrganizationId: `org-personal-${str(user.id)}`,
  creatorRole: PERSONAL_ORG_CREATOR_ROLE,
});

// The GLOBAL app-authz role and the org-structural role are orthogonal: a valid
// global role is one of member/admin/superadmin and is never the org-only
// `owner`. Mapping `owner` onto the global tier is a namespace collision.
export const assertOrthogonalRoles = ({
  globalRole,
  orgRole,
}: {
  globalRole: string;
  orgRole: string;
}): boolean => {
  const globalIsAppRole = appRoleSchema.safeParse(globalRole).success;
  const orgIsStructural = ORG_STRUCTURAL_ROLES.has(orgRole);
  const noOwnerCollision = globalRole !== PERSONAL_ORG_CREATOR_ROLE;
  return globalIsAppRole && orgIsStructural && noOwnerCollision;
};

// The documents/delta perimeter is keyed on the server-derived userId, NEVER the
// organizationId — org-scoped tenancy is the RBAC/membership layer, not the
// document data perimeter.
export const documentsPerimeterKey = (session: {
  user: { id: string };
  activeOrganizationId?: string;
}): string => session.user.id;

// --- The user additionalFields config, single-sourced from the db shape -----

const additionalFields: Record<
  string,
  { type: "string"; required: boolean; defaultValue?: string }
> = {
  locale: { type: "string", required: false, defaultValue: LOCALE_DEFAULT },
  given_name: { type: "string", required: true },
  family_name: { type: "string", required: true },
};

// Guard against drift: every field in the canonical db shape must be exposed.
for (const key of Object.keys(userAdditionalFields.shape)) {
  if (!(key in additionalFields)) {
    throw new Error(
      `identity field "${key}" is missing from the auth additionalFields config`
    );
  }
}

// --- The better-auth singleton ----------------------------------------------

export const auth = betterAuth({
  database: surrealAdapter,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.CORS_ORIGIN],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
  },
  user: { additionalFields },
  databaseHooks: {
    session: {
      create: {
        // Data-shaping only: seed a fresh self-registered member's active org to
        // its auto-provisioned personal org so the session always resolves one.
        before: (session) =>
          Promise.resolve({
            data: {
              ...session,
              activeOrganizationId: seedActiveOrganization({
                user: { id: session.userId },
              }).activeOrganizationId,
            },
          }),
      },
    },
  },
  plugins: [
    organization({ ac, roles, creatorRole: PERSONAL_ORG_CREATOR_ROLE }),
    jwt({
      // ES256 is load-bearing: the default JWKS algorithm would leave the
      // offline-verify leg without a working ECDSA path. Never left to default.
      jwks: { keyPairConfig: { alg: "ES256" } },
      jwt: {
        definePayload: ({ user, session }) =>
          projectSessionFields({ user, session }),
      },
    }),
    // Fold the same identity projection over the get-session response so the
    // relay middleware reading the get-session body carries locale/given_name/
    // family_name — not just the offline-verify JWT leg above.
    customSession(({ user, session }) =>
      Promise.resolve(projectGetSession({ user, session }))
    ),
    bearer(),
    admin({
      ac,
      roles,
      defaultRole: "member",
      adminRoles: ["admin", "superadmin"],
    }),
    tanstackStartCookies(),
  ],
});
