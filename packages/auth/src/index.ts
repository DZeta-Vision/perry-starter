import {
  APP_ROLE_RANK as APP_ROLE_RANK_SOURCE,
  appRoleSchema,
  LOCALE_DEFAULT,
  userAdditionalFields,
} from "@perry-starter/db/shapes/identity";
import { env } from "@perry-starter/env/server";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import {
  admin,
  bearer,
  customSession,
  jwt,
  organization,
} from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { recordAuthAudit } from "./auth-audit";
import { VERIFICATION_TOKEN_TTL_SECONDS } from "./email-verification";
import { HIBP_SCREENED_PATHS, screenPasswordForBreach } from "./hibp-screen";
import {
  GENERIC_OAUTH_ERROR_ROUTE,
  oauthAccountLinking,
  oauthSocialProviders,
} from "./oauth";
import {
  NIST_MAX_PASSWORD_LENGTH,
  NIST_MIN_PASSWORD_LENGTH,
} from "./password-policy";
import {
  PERSONAL_ORG_OWNER_ROLE,
  personalOrgIdFor,
  provisionPersonalOrg,
} from "./personal-org";
import { surrealAdapter } from "./surreal-adapter";
import {
  dispatchVerificationEmail,
  verificationEmailSender,
} from "./verification-email";

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
// The ONE statement map. `document` is the owner-data capability; `user` is the
// admin tier (role assignment / listing); `audit` is the append-only audit read
// tier. Both enforcement legs (the in-process tRPC middleware AND the SurrealDB
// row-level PERMISSIONS) derive from THIS object so they cannot drift. Exported
// so the row-PERMISSIONS generator reads the same resource set.
export const statement = {
  document: ["create", "read", "update", "delete"],
  user: ["list", "set-role"],
  audit: ["read"],
} as const;

export const ac = createAccessControl(statement);

// member < admin < superadmin. `set-role` is held by superadmin ONLY (role
// assignment is superadmin-gated; the numeric hierarchy forbids self-elevation).
export const roles = {
  member: ac.newRole({ document: ["read"] }),
  admin: ac.newRole({
    document: ["create", "read", "update", "delete"],
    user: ["list"],
    audit: ["read"],
  }),
  superadmin: ac.newRole({
    document: ["create", "read", "update", "delete"],
    user: ["list", "set-role"],
    audit: ["read"],
  }),
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
// GLOBAL app-authz roles (member/admin/superadmin). Single-sourced with the
// provisioning module so the seeded active org and the provisioned row agree.
const PERSONAL_ORG_CREATOR_ROLE = PERSONAL_ORG_OWNER_ROLE;

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
  activeOrganizationId: personalOrgIdFor(str(user.id)),
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

// --- Registration-time hooks (D1 personal-org provisioning + verification mail) -

// The minimal adapter surface the provisioning writes through (the better-auth
// `context.context.adapter`). Typed loosely so this module never couples to
// better-auth's internal adapter generics.
interface AdapterCreate {
  create: (args: { data: unknown; model: string }) => Promise<unknown>;
}

// D1 personal-org provisioning, wired into `databaseHooks.user.create.after`. This
// is the REAL hook that actually creates the personal organization (+ the owner
// membership) for every self-registered member, so the session's
// activeOrganizationId resolves to a real, non-dangling row. Params are `unknown`
// (with `context` optional) so the function is assignable to the better-auth hook
// slot regardless of its exact signature; it narrows internally.
const provisionOnUserCreate = async (
  createdUser: unknown,
  context?: unknown
): Promise<void> => {
  const adapter = (
    context as { context?: { adapter?: AdapterCreate } } | undefined
  )?.context?.adapter;
  const user = createdUser as { given_name?: string; id?: string };
  if (!adapter || typeof user.id !== "string") {
    return;
  }
  await provisionPersonalOrg(
    { given_name: user.given_name, id: user.id },
    {
      createMembership: async (membership) => {
        await adapter.create({ data: membership, model: "member" });
      },
      createOrganization: async (organization) => {
        await adapter.create({ data: organization, model: "organization" });
      },
    }
  );
};

// NIST 800-63B breach screening on the REAL credential-setting paths — the
// fail-OPEN replacement for the throwing `haveIBeenPwned()` plugin (which 500s
// sign-up on a pwnedpasswords.com outage). Wired as the better-auth `before`
// middleware: a known-breached password is rejected with `PASSWORD_COMPROMISED`,
// but on a range-API outage the NIST-valid password is accepted (the screen falls
// open and records `auth.hibp_fallback`), so a third-party outage never bricks
// sign-up. The screen runs BEFORE the account-existence check, so its rejection is
// existence-independent and the anti-enumeration normalizer surfaces it unchanged.
const PASSWORD_COMPROMISED_MESSAGE = "auth.error.password_compromised";

const breachScreenBeforeHook = createAuthMiddleware(async (ctx) => {
  if (!HIBP_SCREENED_PATHS.has(ctx.path)) {
    return;
  }
  const password = (ctx.body as { password?: unknown } | undefined)?.password;
  if (typeof password !== "string") {
    return;
  }
  const { breached } = await screenPasswordForBreach(password);
  if (breached) {
    throw new APIError("BAD_REQUEST", {
      code: "PASSWORD_COMPROMISED",
      message: PASSWORD_COMPROMISED_MESSAGE,
    });
  }
});

// The verification-email dispatch wired into `emailVerification.sendVerificationEmail`.
// SDK-free: the real Resend sender is injected by the worker via
// `configureVerificationEmailSender`; the default is a safe no-op. Params are
// `unknown` so the function fits the better-auth slot regardless of its signature.
const sendVerificationEmail = async (
  data: unknown,
  _request?: unknown
): Promise<void> => {
  const payload = data as {
    token?: string;
    url?: string;
    user?: { email?: string; locale?: string };
  };
  await dispatchVerificationEmail(
    {
      locale: payload.user?.locale,
      to: payload.user?.email ?? "",
      verifyToken: payload.token ?? "",
      verifyUrl: payload.url ?? "",
    },
    { audit: recordAuthAudit, send: verificationEmailSender() }
  );
};

// --- The better-auth singleton ----------------------------------------------

// The full authority config, parameterized ONLY by the storage adapter. Production
// passes the SurrealDB-over-HTTP adapter; the acceptance harness passes an in-memory
// adapter so tests drive the SAME plugins, the SAME breach-screen before-hook, the
// SAME registration/session hooks, and the SAME options — never a synthetic
// parallel layer. Swapping the adapter is the only difference between the shipped
// authority and the in-process test authority.
export const buildAuthOptions = (
  database: BetterAuthOptions["database"]
): BetterAuthOptions => ({
  database,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.CORS_ORIGIN],
  // Server-side OAuth: GitHub + Google, with account linking confined to the
  // trusted providers and matching verified emails. CSRF state/origin checks are
  // left ON (better-auth defaults) — `account.skipStateCookieCheck` and
  // `advanced.disableCSRFCheck`/`disableOriginCheck` are never set.
  socialProviders: oauthSocialProviders,
  account: { accountLinking: oauthAccountLinking },
  // Any OAuth failure (a provider denial, a CSRF state mismatch/replay, an
  // adapter exception) redirects to the SAME generic error surface — no provider
  // name, error code, or stack leaked, no per-cause divergence.
  onAPIError: { errorURL: GENERIC_OAUTH_ERROR_ROUTE },
  emailAndPassword: {
    // D5: no usable session token at registration — the token lands at the
    // post-verification sign-in, never auto-signed-in at sign-up.
    autoSignIn: false,
    enabled: true,
    // NIST 800-63B length bounds (single-sourced; no composition/rotation rules).
    maxPasswordLength: NIST_MAX_PASSWORD_LENGTH,
    minPasswordLength: NIST_MIN_PASSWORD_LENGTH,
    requireEmailVerification: true,
  },
  // Bilingual Resend verification email, time-limited token (TTL 1h), sent on
  // sign-up. The send path destructures { data, error } and never throws.
  emailVerification: {
    expiresIn: VERIFICATION_TOKEN_TTL_SECONDS,
    sendOnSignUp: true,
    sendVerificationEmail,
  },
  user: { additionalFields },
  // HIBP breach screening on the credential-setting paths — fail-OPEN (see
  // breachScreenBeforeHook). Replaces the throwing haveIBeenPwned() plugin.
  hooks: { before: breachScreenBeforeHook },
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
    user: {
      create: {
        // D1: provision the personal organization (+ owner membership) for every
        // self-registered member so activeOrganizationId is non-dangling.
        after: provisionOnUserCreate,
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

export const auth = betterAuth(buildAuthOptions(surrealAdapter));
