import { env } from "@perry-starter/env/server";
import type { BetterAuthOptions } from "better-auth";

// Server-side OAuth configuration for the cloud better-auth authority (the sole
// authn/authz authority). GitHub + Google sign-in is configured here, consumed by the
// better-auth singleton in ./index. Account linking is restricted to the trusted
// providers and refuses to silently link a differently-emailed account. CSRF
// `state` + origin checks stay ON (better-auth defaults) — the wiring never opts
// out of them. This module imports ONLY the validated env contract and a
// better-auth type; no api/infra coupling.

// --- Provider credentials, sourced from the validated server env -------------

// Client id/secret are drawn from the @perry-starter/env/server contract, never
// baked into source as literals (the four OAuth keys are optional on the contract
// so the relay tier — which holds none — still validates at boot).
export const oauthProviderConfig = {
  github: {
    clientId: env.GITHUB_CLIENT_ID ?? "",
    clientSecret: env.GITHUB_CLIENT_SECRET ?? "",
  },
  google: {
    clientId: env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
  },
} as const;

type SocialProvidersOptions = NonNullable<BetterAuthOptions["socialProviders"]>;
type AccountOptions = NonNullable<BetterAuthOptions["account"]>;
type AccountLinkingOptions = NonNullable<AccountOptions["accountLinking"]>;

// The social-provider map folded into the better-auth singleton's options. Both
// providers are configured so `auth.options.socialProviders.{github,google}`
// resolve.
export const oauthSocialProviders: SocialProvidersOptions = {
  github: {
    clientId: oauthProviderConfig.github.clientId,
    clientSecret: oauthProviderConfig.github.clientSecret,
  },
  google: {
    clientId: oauthProviderConfig.google.clientId,
    clientSecret: oauthProviderConfig.google.clientSecret,
  },
};

// Account linking is enabled but confined to the trusted providers, and a linked
// account must carry the SAME verified email (allowDifferentEmails:false) — a
// differently-emailed provider account is never silently linked.
export const oauthAccountLinking: AccountLinkingOptions = {
  allowDifferentEmails: false,
  enabled: true,
  trustedProviders: ["github", "google"],
};

// --- Personal-org bootstrap for a brand-new OAuth account --------------------

// The org-structural role of an organization's creator — DISTINCT from the
// GLOBAL app-authz role. Single-sourced with the email/password provisioner.
const ORG_STRUCTURAL_OWNER_ROLE = "owner";

// The default GLOBAL app-authz role for a freshly created account. Orthogonal to
// the org-structural owner above: owner is org-only and never bleeds into the
// global authorization tier (no namespace collision).
const DEFAULT_GLOBAL_APP_ROLE = "member";

export interface OAuthAccountUser {
  readonly email?: string;
  readonly family_name?: string;
  readonly given_name?: string;
  readonly id: string;
  readonly locale?: string;
  readonly name?: string;
}

// The minimal organization-adapter surface the OAuth bootstrap writes through —
// the SurrealDB better-auth adapter in production, an in-memory stub in tests.
export interface OAuthOrgAdapter {
  createOrganization: (input: {
    ownerId: string;
  }) => Promise<{ id: string; creatorRole: string }>;
  findActiveOrganization: (
    userId: string
  ) => Promise<{ id: string; ownerId: string } | null>;
  updateUser: (input: {
    id: string;
    locale?: string;
  }) => Promise<{ id: string; locale?: string }>;
}

export interface ProvisionedOAuthAccount {
  readonly globalRole: string;
  readonly memberRole: string;
  readonly organizationId: string;
}

// Auto-provision a personal organization for a brand-new OAuth account: the
// creator is the org-structural `owner`; the account's global app-authz role is
// the default `member`. Reuses the same single personal-org bootstrap the
// email/password path uses — it does not fork a second provisioner.
export const provisionPersonalOrgForOAuthAccount = async (
  user: OAuthAccountUser,
  adapter: OAuthOrgAdapter
): Promise<ProvisionedOAuthAccount> => {
  const organization = await adapter.createOrganization({ ownerId: user.id });
  return {
    globalRole: DEFAULT_GLOBAL_APP_ROLE,
    memberRole: organization.creatorRole || ORG_STRUCTURAL_OWNER_ROLE,
    organizationId: organization.id,
  };
};

export interface ResolvedActiveOrganization {
  readonly activeOrganizationId: string;
}

// Resolve the session's active organization for an OAuth user: its existing
// personal org if one is found, otherwise the freshly provisioned one. The
// resolved id is always non-empty so the session never resolves a dangling org.
export const resolveActiveOrganization = async (
  user: { id: string },
  adapter: OAuthOrgAdapter
): Promise<ResolvedActiveOrganization> => {
  const existing = await adapter.findActiveOrganization(user.id);
  const organization =
    existing ?? (await adapter.createOrganization({ ownerId: user.id }));
  return { activeOrganizationId: organization.id };
};

export interface ProjectedIdentityFields {
  readonly family_name?: string;
  readonly given_name?: string;
  readonly id: string;
  readonly locale?: string;
}

// Project the canonical identity additionalFields into the session payload —
// locale/given_name/family_name survive instead of being dropped (the known
// better-auth getSession additionalFields gap).
export const projectIdentityFields = (
  user: OAuthAccountUser
): ProjectedIdentityFields => ({
  family_name: user.family_name,
  given_name: user.given_name,
  id: user.id,
  locale: user.locale,
});

// Migrate the device-local pre-auth locale onto the account at first OAuth
// sign-up: if the account carries no locale of its own, the pre-auth locale is
// persisted onto it.
export const migratePreAuthLocale = async (
  account: { id: string; locale?: string },
  options: { preAuthLocale?: string },
  adapter: OAuthOrgAdapter
): Promise<{ id: string; locale?: string }> => {
  const locale =
    account.locale && account.locale.length > 0
      ? account.locale
      : options.preAuthLocale;
  return await adapter.updateUser({ id: account.id, locale });
};

// --- Provider verified-email decides the verification wall -------------------

export interface ProviderEmailProfile {
  readonly email: string;
  readonly emailVerified: boolean;
}

export interface MappedAccountState {
  readonly email: string;
  readonly emailVerified: boolean;
  readonly heldOnVerificationWall: boolean;
}

// A provider's verified-email claim — NOT the mere fact of an OAuth login —
// decides the wall: a verified provider email is created emailVerified=true and
// bypasses the verification wall; an unverified provider email is emailVerified
// =false and held on the wall (the same treatment the email/password path
// enforces).
export const mapProviderEmailVerification = (
  profile: ProviderEmailProfile
): MappedAccountState => {
  const verified = profile.emailVerified === true;
  return {
    email: profile.email,
    emailVerified: verified,
    heldOnVerificationWall: !verified,
  };
};

// --- Generic, non-leaking OAuth error surface --------------------------------

// The single fixed generic error route every OAuth failure resolves to. No
// per-cause divergence, no enumeration of which provider failed or why.
export const GENERIC_OAUTH_ERROR_ROUTE = "/auth/error";

export interface OAuthErrorInput {
  readonly cause?: unknown;
  readonly error?: string;
  readonly error_description?: string;
  readonly provider?: string;
  readonly status?: number;
}

// Compose the redirect target for ANY OAuth failure — a provider denial, a
// provider 5xx, an internal adapter exception, or a CSRF state-validation
// failure. The input is deliberately DISCARDED: the redirect carries no provider
// name, no provider error code, no stack frame, no internal exception message —
// only the fixed generic route. This is the no-leak invariant.
export const genericOAuthErrorRedirect = (_error: OAuthErrorInput): string =>
  GENERIC_OAUTH_ERROR_ROUTE;
