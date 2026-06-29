// Acceptance tests for the server-side OAuth flow on the admin/cloud surface.
//
// These assert the cloud better-auth authority is configured for GitHub +
// Google sign-in with CSRF state and account linking, that a brand-new OAuth
// account is auto-provisioned a personal organization (its creator the
// org-structural owner) whose id resolves as the session's active organization,
// that the identity additionalFields (locale / given_name / family_name) are
// projected into the session payload, and that a provider's verified-email
// claim — not the mere fact of an OAuth login — decides whether the account
// bypasses the mandatory email-verification wall.
//
// RED PHASE: every test is `test.skip`. The OAuth config module and the cloud
// auth singleton's adapter do not exist yet, so all imports of not-yet-existing
// modules and all IO are dynamic and live INSIDE the skipped bodies; the only
// top-level imports are vitest and node builtins. The behavioral handler-driven
// legs additionally depend on the SurrealDB better-auth adapter (a separate
// critical-path precondition) and stay skipped until it lands.

import { describe, expect, test } from "vitest";

// Hoisted (top-level) regex: a hard-coded provider secret literal in the module.
const INLINE_SECRET_RE = /clientSecret\s*:\s*["'][^"']+["']/;

describe("server-side OAuth provider configuration", () => {
  test("configures both GitHub and Google social providers", async () => {
    const { auth } = await import("../src/index");
    const providers = auth.options.socialProviders ?? {};
    expect(providers.github).toBeDefined();
    expect(providers.google).toBeDefined();
  });

  test("draws OAuth client credentials from the validated server env, never inlined", async () => {
    const { oauthProviderConfig } = await import("../src/oauth");
    // The config helper reads the env contract; the secrets are not string
    // literals baked into the module source.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(process.cwd(), "packages", "auth", "src", "oauth.ts"),
      "utf8"
    );
    expect(oauthProviderConfig.github.clientId).toBeTruthy();
    expect(oauthProviderConfig.google.clientId).toBeTruthy();
    // No hard-coded provider secret literal in the module.
    expect(source).not.toMatch(INLINE_SECRET_RE);
  });

  test("enables account linking restricted to the trusted providers with matching verified emails", async () => {
    const { auth } = await import("../src/index");
    const linking = auth.options.account?.accountLinking;
    expect(linking?.enabled).toBe(true);
    expect(linking?.trustedProviders).toEqual(
      expect.arrayContaining(["github", "google"])
    );
    // A linked account must share the same verified email — different emails
    // are not silently linked.
    expect(linking?.allowDifferentEmails).toBe(false);
  });

  test("leaves CSRF state and origin checks ON (defaults not disabled)", async () => {
    const { auth } = await import("../src/index");
    // The anti-CSRF state cookie check and origin check are better-auth
    // defaults; the OAuth wiring must not opt out of them.
    expect(auth.options.account?.skipStateCookieCheck).not.toBe(true);
    expect(auth.options.advanced?.disableCSRFCheck).not.toBe(true);
    expect(auth.options.advanced?.disableOriginCheck).not.toBe(true);
  });
});

describe("personal-org bootstrap for a brand-new OAuth account", () => {
  test("auto-provisions a personal organization whose creator is the org-structural owner", async () => {
    const { provisionPersonalOrgForOAuthAccount } = await import(
      "../src/oauth"
    );
    const created = await provisionPersonalOrgForOAuthAccount(
      { id: "user:new-oauth", email: "new@example.test", name: "New User" },
      stubOrgAdapter()
    );
    expect(created.organizationId).toBeTruthy();
    // The creator's ORG-structural role is owner (comma-separated string split
    // on ','), distinct from the global app-authz role.
    expect(created.memberRole.split(",")).toContain("owner");
  });

  test("resolves the freshly created personal org as the session active organization", async () => {
    const { resolveActiveOrganization } = await import("../src/oauth");
    const session = await resolveActiveOrganization(
      { id: "user:new-oauth" },
      stubOrgAdapter()
    );
    expect(session.activeOrganizationId).toBeTruthy();
  });

  test("assigns the default GLOBAL member role, orthogonal to the org-structural owner", async () => {
    const { provisionPersonalOrgForOAuthAccount } = await import(
      "../src/oauth"
    );
    const created = await provisionPersonalOrgForOAuthAccount(
      { id: "user:new-oauth", email: "new@example.test", name: "New User" },
      stubOrgAdapter()
    );
    // The global app-authz role is `member` by default — owner is org-only and
    // does not bleed into the global authorization tier.
    expect(created.globalRole).toBe("member");
  });

  test("projects locale, given_name and family_name into the session payload", async () => {
    const { projectIdentityFields } = await import("../src/oauth");
    const payload = projectIdentityFields({
      id: "user:new-oauth",
      locale: "fr",
      given_name: "Jean",
      family_name: "Dupont",
    });
    expect(payload.locale).toBe("fr");
    expect(payload.given_name).toBe("Jean");
    expect(payload.family_name).toBe("Dupont");
  });

  test("migrates the device-local pre-auth locale onto the account at first OAuth sign-up", async () => {
    const { migratePreAuthLocale } = await import("../src/oauth");
    const account = await migratePreAuthLocale(
      { id: "user:new-oauth", locale: undefined },
      { preAuthLocale: "fr" },
      stubOrgAdapter()
    );
    expect(account.locale).toBe("fr");
  });
});

describe("provider verified-email decides the verification wall", () => {
  test("a verified provider email creates an account that bypasses the wall", async () => {
    const { mapProviderEmailVerification } = await import("../src/oauth");
    const mapped = mapProviderEmailVerification({
      email: "verified@example.test",
      emailVerified: true,
    });
    expect(mapped.emailVerified).toBe(true);
    expect(mapped.heldOnVerificationWall).toBe(false);
  });

  test("an unverified provider email is held on the verification wall", async () => {
    const { mapProviderEmailVerification } = await import("../src/oauth");
    const mapped = mapProviderEmailVerification({
      email: "unverified@example.test",
      emailVerified: false,
    });
    expect(mapped.emailVerified).toBe(false);
    expect(mapped.heldOnVerificationWall).toBe(true);
  });

  test("the bypass derives only from the provider claim, never from the login itself", async () => {
    const { mapProviderEmailVerification } = await import("../src/oauth");
    // Two OAuth logins, identical except the provider's verified-email claim —
    // only the claim flips the wall decision.
    const verified = mapProviderEmailVerification({
      email: "a@example.test",
      emailVerified: true,
    });
    const unverified = mapProviderEmailVerification({
      email: "a@example.test",
      emailVerified: false,
    });
    expect(verified.heldOnVerificationWall).toBe(false);
    expect(unverified.heldOnVerificationWall).toBe(true);
  });
});

// A minimal in-memory organization adapter stub the bootstrap helpers run over,
// so the personal-org provisioning is exercised without the real SurrealDB
// adapter (which is a separate critical-path precondition).
function stubOrgAdapter() {
  const orgs: Array<{ id: string; ownerId: string }> = [];
  return {
    createOrganization: (input: { ownerId: string }) => {
      const id = `org:personal-${orgs.length}`;
      orgs.push({ id, ownerId: input.ownerId });
      return Promise.resolve({ id, creatorRole: "owner" });
    },
    findActiveOrganization: (userId: string) =>
      Promise.resolve(orgs.find((o) => o.ownerId === userId) ?? null),
    updateUser: (input: { id: string; locale?: string }) =>
      Promise.resolve({
        id: input.id,
        locale: input.locale,
      }),
  };
}
