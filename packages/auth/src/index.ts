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
import { blockHardDelete } from "./hard-delete-block";
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
import {
  dispatchResetEmail,
  RESET_PASSWORD_TOKEN_TTL_SECONDS,
  resetEmailSender,
} from "./reset-email";
import { isResetScopeValue } from "./reset-token-scope";
import { surrealAdapter } from "./surreal-adapter";
import {
  dispatchVerificationEmail,
  verificationEmailSender,
} from "./verification-email";

// packages/auth is the SOLE authn/authz authority. It imports ONLY
// packages/db (canonical identity shapes) and packages/env (the SURREAL_*/
// BETTER_AUTH_* contract) — never packages/api or packages/infra. The singleton
// runs ONLY on the apps/worker Cloudflare host; the browser calls it via
// better-auth/client and the Perry daemon forwards a bearer token + verifies the
// ES256 JWT offline. No other unit issues sessions or tokens.

// --- The single-sourced RBAC matrix -----------------------------------------

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
//
// The `user` resource DELIBERATELY exposes only `list`/`set-role` — NO `delete`
// and NO `impersonate` action. That omission is LOAD-BEARING, not incidental:
// better-auth's admin plugin `removeUser`/`impersonateUser` endpoints do NOT run
// `user.deleteUser.beforeDelete` (that hook covers only the self-service
// `/delete-user` path); they instead gate on `hasPermission({ user: ['delete'] })`
// / `({ user: ['impersonate'] })` against THESE role grants. So the ABSENCE of a
// `user:delete`/`user:impersonate` action is precisely what keeps the admin
// hard-delete/impersonate paths withheld. The hard-delete-block gate asserts this
// structurally, so re-adding either action reddens CI.
export const statement = {
  document: ["create", "read", "update", "delete"],
  user: ["list", "set-role"],
  audit: ["read"],
} as const;

export const ac = createAccessControl(statement);

// The per-role capability grants — single-sourced HERE so BOTH `ac.newRole()` (the
// in-process authorize leg the admin plugin's `hasPermission` consults) AND the
// hard-delete-block structural gate read the SAME data. member < admin <
// superadmin. `set-role` is held by superadmin ONLY (role assignment is
// superadmin-gated; the numeric hierarchy forbids self-elevation). NO role grants
// `user:delete` or any `impersonate` action, so the admin hard-delete/impersonate
// paths stay denied by this permission gap.
export const roleGrants = {
  member: { document: ["read"] },
  admin: {
    document: ["create", "read", "update", "delete"],
    user: ["list"],
    audit: ["read"],
  },
  superadmin: {
    document: ["create", "read", "update", "delete"],
    user: ["list", "set-role"],
    audit: ["read"],
  },
} as const;

export const roles = {
  member: ac.newRole(roleGrants.member),
  admin: ac.newRole(roleGrants.admin),
  superadmin: ac.newRole(roleGrants.superadmin),
};

// The admin-tier role set — DERIVED from the ONE matrix (the tiers the matrix
// grants the admin-surface `user:list` capability), never a hand-typed literal.
// It is fed to the admin() plugin's `adminRoles` below so the auth library's
// admin role map IS the matrix's; a divergent admin role cannot be introduced.
// The fail-closed admin checkpoint derives the SAME decision from `rbac.ts`
// (`adminTierRoles`/`holdsAdminSurface`), keyed on the same `user:list` hinge.
export const ADMIN_TIER_ROLES: string[] = (
  ["member", "admin", "superadmin"] as const
).filter((tier) => roles[tier].authorize({ user: ["list"] }, "AND").success);

// The admin() plugin options — extracted and EXPORTED so the hard-delete-block gate
// can assert the two admin-path bypass surfaces stay UNSET. Neither `adminUserIds`
// (the `hasPermission` short-circuit that returns true for any listed id, bypassing
// the role check entirely) nor `allowImpersonatingAdmins`/`impersonationSessionDuration`
// (the impersonation surface) is set here — so the admin `removeUser`/`impersonateUser`
// endpoints have no bypass and stay denied by the `roleGrants` permission gap above.
// Setting any of these would silently open a hard-delete/impersonation path; the gate
// reddens if they ever appear.
export const adminPluginOptions = {
  ac,
  // Matrix-derived admin role set (the tiers holding `user:list`) — NOT a hand-typed
  // literal — so the auth library never sanctions an admin role the one matrix does
  // not, and the fail-closed checkpoint reads the same set.
  adminRoles: ADMIN_TIER_ROLES,
  defaultRole: "member",
  roles,
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

// --- Session establishment + personal-org bootstrap -------------------------

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
  // The forced-password-change flag rides through the projection alongside the
  // identity fields, so the gate middleware reads a real session value (never
  // the dropped-additionalField `undefined`). Coerced to a strict boolean — an
  // absent flag is "not required".
  requirePasswordChange: user.requirePasswordChange === true,
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
  {
    type: "boolean" | "string";
    required: boolean;
    defaultValue?: boolean | string;
  }
> = {
  locale: { type: "string", required: false, defaultValue: LOCALE_DEFAULT },
  given_name: { type: "string", required: true },
  family_name: { type: "string", required: true },
  // The forced-password-change flag. A rotation-required account is
  // blocked from every op except change-password; the gate middleware reads this
  // off the session. better-auth does not surface additionalFields through
  // getSession by default, so it is ALSO folded into projectSessionFields above —
  // without both, the middleware reads `undefined` and the non-dismissable gate
  // never mounts. Optional + defaulting false so existing rows read "not required".
  requirePasswordChange: {
    type: "boolean",
    required: false,
    defaultValue: false,
  },
  // The GDPR erasure tombstones. A live account carries neither; the erasure
  // request stamps them via a SOFT flip (never a hard DELETE), so the row survives
  // recoverable until the deferred crypto-shred. Optional so existing rows read as
  // "not erased". Single-sourced alongside the identity shape's userAdditionalFields.
  deletedAt: { type: "string", required: false },
  erasureRequestedAt: { type: "string", required: false },
};

// Guard against drift: every field in the canonical db shape must be exposed.
for (const key of Object.keys(userAdditionalFields.shape)) {
  if (!(key in additionalFields)) {
    throw new Error(
      `identity field "${key}" is missing from the auth additionalFields config`
    );
  }
}

// --- Registration-time hooks (personal-org provisioning + verification mail) -

// The minimal adapter surface the provisioning writes through (the better-auth
// `context.context.adapter`). Typed loosely so this module never couples to
// better-auth's internal adapter generics.
interface AdapterCreate {
  create: (args: {
    data: unknown;
    model: string;
    // better-auth's adapter factory STRIPS a caller-supplied `id` (and warns)
    // unless `forceAllowId` is set, generating its own instead. The personal-org
    // provisioning needs its deterministic id honored, so it opts in per-create.
    forceAllowId?: boolean;
  }) => Promise<unknown>;
}

// The minimal adapter surface the prior-reset-token invalidation deletes
// through (the same `context.context.adapter` the provisioning hook reaches).
interface AdapterDeleteMany {
  deleteMany: (args: {
    model: string;
    where: { field: string; value: unknown }[];
  }) => Promise<number>;
}

// Personal-org provisioning, wired into `databaseHooks.user.create.after`. This
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
        // Honor the deterministic personalOrgIdFor id (forceAllowId) so the
        // persisted row matches the activeOrganizationId the session derives —
        // without it better-auth discards the id and the active org dangles. The
        // member-row create below carries no id and is left untouched.
        await adapter.create({
          data: organization,
          forceAllowId: true,
          model: "organization",
        });
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

// The credential a screened path submits. Sign-up carries `password`; the forced-
// change and reset paths carry `newPassword` — reading only `password` would leave
// the new password on those paths silently UNSCREENED (the one HIBP control that
// must cover the only-unblocked forced-change action). Prefer `newPassword` so
// the change/reset surfaces are screened; fall back to `password` for sign-up.
const credentialFromBody = (
  body: { newPassword?: unknown; password?: unknown } | undefined
): string | undefined => {
  if (typeof body?.newPassword === "string") {
    return body.newPassword;
  }
  if (typeof body?.password === "string") {
    return body.password;
  }
  return;
};

const breachScreenBeforeHook = createAuthMiddleware(async (ctx) => {
  if (!HIBP_SCREENED_PATHS.has(ctx.path)) {
    return;
  }
  const candidate = credentialFromBody(
    ctx.body as { newPassword?: unknown; password?: unknown } | undefined
  );
  if (candidate === undefined) {
    return;
  }
  const { breached } = await screenPasswordForBreach(candidate);
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

// The reset-email dispatch wired into `emailAndPassword.sendResetPassword`. Same
// SDK-free shape as the verification path: the real Resend sender is injected by
// the worker; the default is a safe no-op. better-auth invokes this with the
// minted single-use reset token + the reset URL; the dispatch is awaited out-of-
// band so it never perturbs the byte-identical neutral reset-request response.
// Params are `unknown` so the function fits the better-auth slot regardless of
// its signature.
const sendResetPasswordEmail = async (
  data: unknown,
  _request?: unknown
): Promise<void> => {
  const payload = data as {
    token?: string;
    url?: string;
    user?: { email?: string; locale?: string };
  };
  await dispatchResetEmail(
    {
      locale: payload.user?.locale,
      resetToken: payload.token ?? "",
      resetUrl: payload.url ?? "",
      to: payload.user?.email ?? "",
    },
    { audit: recordAuthAudit, send: resetEmailSender() }
  );
};

// Prior-reset-token invalidation — token hardening on the SHIPPED path. better-
// auth has NO native "one live reset token per user" control: each
// /request-password-reset mints a fresh token and leaves any earlier one valid
// until it independently expires or is consumed, so two mailed reset links can
// be redeemable at once. We close that window on the verification-store create
// seam — the place a reset token is persisted. Before a new verification value is
// written, delete every PRIOR reset-scope row for the same reset target. The new
// row is not created until this `before` hook returns, so only PRIOR tokens are
// removed; a freshly issued token immediately invalidates any earlier one.
//
// SCOPING (see ./reset-token-scope): mandatory-2FA enrolment adds a SECOND
// user-keyed verification writer (the pending-enrolment marker), so this purge is
// no longer allowed to sweep every row for the user. The store persists the
// identifier HASHED — and the create hook observes it already hashed — so the
// purge cannot scope by a literal `reset-password:` identifier prefix; the
// equivalent scoping is realized on the `value` axis. A reset token keeps the bare
// reset-target value; the two-factor enrolment marker lives under a distinct
// namespace. So the purge (a) fires ONLY for a reset-scope creation and (b)
// deletes ONLY rows under that bare value — a two-factor / recovery enrolment row
// is never in the delete set. Reached via the same `context.context.adapter` seam
// the personal-org provisioning uses; the hook narrows internally so it fits the
// better-auth slot regardless of signature.
const invalidatePriorResetTokens = async (
  verification: unknown,
  context?: unknown
): Promise<void> => {
  const adapter = (
    context as { context?: { adapter?: AdapterDeleteMany } } | undefined
  )?.context?.adapter;
  const value = (verification as { value?: unknown } | undefined)?.value;
  if (!adapter || typeof value !== "string" || value.length === 0) {
    return;
  }
  // A two-factor / recovery enrolment marker creation (namespaced value) must not
  // trigger a purge; only a reset-scope creation does.
  if (!isResetScopeValue(value)) {
    return;
  }
  await adapter.deleteMany({
    model: "verification",
    where: [{ field: "value", value }],
  });
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
    // No usable session token at registration — the token lands at the
    // post-verification sign-in, never auto-signed-in at sign-up.
    autoSignIn: false,
    enabled: true,
    // NIST 800-63B length bounds (single-sourced; no composition/rotation rules).
    maxPasswordLength: NIST_MAX_PASSWORD_LENGTH,
    minPasswordLength: NIST_MIN_PASSWORD_LENGTH,
    requireEmailVerification: true,
    // Secure single-use reset: better-auth mints a token persisted in the
    // verification store and CONSUMES it (deletes the row) on the first
    // successful reset, so a replayed/already-used token finds nothing and is
    // rejected — single-use is enforced on the shipped path, not bolted on. The
    // token is time-boxed to 30 minutes (distinct from the 1h verify TTL). The
    // token identifier is stored HASHED (see `verification.storeIdentifier`
    // below) and a fresh request invalidates any prior token (see the
    // `databaseHooks.verification` hook below). ENTROPY NOTE: better-auth mints
    // the reset token with `generateId(24)` — 24 chars over a 62-symbol alphabet
    // ≈ 143 bits — and the length is HARD-CODED in the library, with no config
    // knob to raise it. 143-bit single-use + 30-min TTL + hashed-at-rest is the
    // shipped floor; a ≥256-bit token would require replacing better-auth's
    // generator and is deferred rather than faked.
    resetPasswordTokenExpiresIn: RESET_PASSWORD_TOKEN_TTL_SECONDS,
    // On a successful reset, ALL of the user's sessions are revoked (not just the
    // current one), so no stale session survives the credential change.
    revokeSessionsOnPasswordReset: true,
    // Bilingual Resend reset email keyed off the account locale; the send path
    // destructures { data, error } and never throws.
    sendResetPassword: sendResetPasswordEmail,
  },
  // Bilingual Resend verification email, time-limited token (TTL 1h), sent on
  // sign-up. The send path destructures { data, error } and never throws.
  emailVerification: {
    expiresIn: VERIFICATION_TOKEN_TTL_SECONDS,
    sendOnSignUp: true,
    sendVerificationEmail,
  },
  // Token-at-rest hardening: store the reset-token identifier HASHED, never the
  // raw token. better-auth persists a reset token as a `verification` row keyed
  // by `reset-password:<token>`; `storeIdentifier: "hashed"` persists
  // base64url(SHA-256(identifier)) instead, so reading the verification store
  // never yields a usable reset token. create/find/consume all hash the
  // identifier symmetrically, so the single-use lookup is unaffected. The setting
  // is global but affects ONLY the reset flow in this configuration — email
  // verification uses a stateless signed JWT and never writes this table.
  verification: { storeIdentifier: "hashed" },
  // The user model + the SELF-SERVICE HARD-DELETE BLOCK. better-auth's deleteUser is
  // a hard delete only; GDPR erasure here is soft-delete + scheduled crypto-shred, so
  // the destructive hard delete must be unreachable. `beforeDelete` covers EXACTLY
  // the self-service `/delete-user` (+ `/delete-user/callback`) path — better-auth
  // invokes it there before `internalAdapter.deleteUser`, so this throw (blockHardDelete)
  // interrupts a self-initiated hard delete before any row is removed. It does NOT
  // cover the admin `/admin/remove-user` or `/admin/impersonate-user` paths — those
  // BYPASS `beforeDelete` and are withheld INSTEAD by the access-control permission
  // gap (the `user` statement/`roleGrants` grant no `delete`/`impersonate` action) and
  // by leaving `adminPluginOptions.adminUserIds`/`allowImpersonatingAdmins` unset. The
  // only erasure surface is the soft-delete request (packages/api erasure router).
  user: {
    additionalFields,
    deleteUser: { enabled: true, beforeDelete: () => blockHardDelete() },
  },
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
        // Provision the personal organization (+ owner membership) for every
        // self-registered member so activeOrganizationId is non-dangling.
        after: provisionOnUserCreate,
      },
    },
    verification: {
      create: {
        // Token hardening: a freshly minted reset token invalidates any prior
        // outstanding reset token for the same user (delete-prior-on-reissue).
        before: invalidatePriorResetTokens,
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
    admin(adminPluginOptions),
    tanstackStartCookies(),
  ],
});

export const auth = betterAuth(buildAuthOptions(surrealAdapter));
