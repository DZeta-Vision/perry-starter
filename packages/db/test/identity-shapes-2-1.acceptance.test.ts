import { describe, expect, test } from "vitest";

// Acceptance tests for the single-sourced identity Zod shapes.
//
// Collection-safe: the only top-level import is `vitest`; each canonical shape
// is pulled in via a dynamic `await import(...)` inside the test body so module
// resolution happens at run time, not at file collection.
//
// These prove (anti-vacuously, both directions) that the single-sourced
// identity shapes live in `packages/db`: the FR/EN locale defaulting to 'en',
// the user/org/member rows (member.role a comma-separated string), the GLOBAL
// member<admin<superadmin app-role hierarchy distinct from the org-structural
// `owner`, and the canonical session-establishment payload the projection must
// satisfy.

// Minimal structural surfaces for the dynamically imported, not-yet-existing
// canonical Zod shapes. The real shapes are hand-authored Zod validators
// exposing .parse / .safeParse.
interface ZodLike {
  readonly parse: (value: unknown) => unknown;
  readonly safeParse: (value: unknown) => { readonly success: boolean };
}

interface IdentityShapes {
  readonly APP_ROLE_RANK: Readonly<Record<string, number>>;
  readonly appRoleSchema: ZodLike;
  readonly localeSchema: ZodLike;
  readonly memberSchema: ZodLike;
  readonly organizationSchema: ZodLike;
  readonly userAdditionalFields: ZodLike;
  readonly userSchema: ZodLike;
}

interface SessionPayloadShapes {
  readonly sessionPayloadSchema: ZodLike;
}

// Pass the subpath specifiers as variables + `@vite-ignore` so the bundler does
// not eagerly resolve them against the package exports map at collection time;
// each import runs only at run time, inside the test body.
const IDENTITY_SPEC = "@perry-starter/db/shapes/identity";
const SESSION_PAYLOAD_SPEC = "@perry-starter/db/shapes/session-payload";

const loadIdentity = async (): Promise<IdentityShapes> =>
  (await import(/* @vite-ignore */ IDENTITY_SPEC)) as unknown as IdentityShapes;

const loadSessionPayload = async (): Promise<SessionPayloadShapes> =>
  (await import(
    /* @vite-ignore */ SESSION_PAYLOAD_SPEC
  )) as unknown as SessionPayloadShapes;

const canonicalUser = {
  id: "user-1",
  email: "ada@example.com",
  emailVerified: false,
  role: "member",
  locale: "fr",
  given_name: "Ada",
  family_name: "Lovelace",
};

const canonicalOrganization = {
  id: "org-1",
  name: "Ada's Workspace",
  slug: "adas-workspace",
};

const canonicalMember = {
  id: "member-1",
  userId: "user-1",
  organizationId: "org-1",
  role: "owner",
};

const canonicalSessionPayload = {
  id: "user-1",
  email: "ada@example.com",
  role: "member",
  activeOrganizationId: "org-1",
  locale: "fr",
  given_name: "Ada",
  family_name: "Lovelace",
};

describe("the single-sourced identity shapes constrain locale, roles and the session payload", () => {
  test("the locale shape defaults to en and accepts only fr and en", async () => {
    const { localeSchema } = await loadIdentity();
    expect(localeSchema.parse(undefined)).toBe("en");
    expect(localeSchema.safeParse("en").success).toBe(true);
    expect(localeSchema.safeParse("fr").success).toBe(true);
  });

  test("the locale shape rejects a locale outside fr and en", async () => {
    const { localeSchema } = await loadIdentity();
    expect(localeSchema.safeParse("de").success).toBe(false);
    expect(localeSchema.safeParse("es").success).toBe(false);
    expect(localeSchema.safeParse("").success).toBe(false);
  });

  test("the user additional-fields shape carries locale, given_name and family_name", async () => {
    const { userAdditionalFields } = await loadIdentity();
    expect(
      userAdditionalFields.safeParse({
        locale: "fr",
        given_name: "Ada",
        family_name: "Lovelace",
      }).success
    ).toBe(true);
  });

  test("the user additional-fields shape rejects a missing name part", async () => {
    const { userAdditionalFields } = await loadIdentity();
    expect(
      userAdditionalFields.safeParse({ locale: "fr", given_name: "Ada" })
        .success
    ).toBe(false);
  });

  test("the canonical user, organization and member rows parse a representative fixture", async () => {
    const { userSchema, organizationSchema, memberSchema } =
      await loadIdentity();
    expect(userSchema.safeParse(canonicalUser).success).toBe(true);
    expect(organizationSchema.safeParse(canonicalOrganization).success).toBe(
      true
    );
    expect(memberSchema.safeParse(canonicalMember).success).toBe(true);
  });

  test("the member role is modeled as a string so multiple roles ride one comma-separated value", async () => {
    const { memberSchema } = await loadIdentity();
    expect(
      memberSchema.safeParse({ ...canonicalMember, role: "admin,member" })
        .success
    ).toBe(true);
  });

  test("the global app-role hierarchy ranks member below admin below superadmin", async () => {
    const { appRoleSchema, APP_ROLE_RANK } = await loadIdentity();
    expect(appRoleSchema.safeParse("member").success).toBe(true);
    expect(appRoleSchema.safeParse("admin").success).toBe(true);
    expect(appRoleSchema.safeParse("superadmin").success).toBe(true);
    expect(APP_ROLE_RANK.member).toBeLessThan(APP_ROLE_RANK.admin);
    expect(APP_ROLE_RANK.admin).toBeLessThan(APP_ROLE_RANK.superadmin);
  });

  test("the global app-role shape rejects the org-structural owner role (orthogonal namespaces)", async () => {
    const { appRoleSchema } = await loadIdentity();
    // `owner` is an organization-structural role, never a GLOBAL app-authz tier.
    expect(appRoleSchema.safeParse("owner").success).toBe(false);
  });

  test("the canonical session-establishment payload requires the projected identity fields", async () => {
    const { sessionPayloadSchema } = await loadSessionPayload();
    expect(
      sessionPayloadSchema.safeParse(canonicalSessionPayload).success
    ).toBe(true);
  });

  test("the session-payload shape rejects a payload missing a projected additional field", async () => {
    const { sessionPayloadSchema } = await loadSessionPayload();
    const { family_name, ...missingFamilyName } = canonicalSessionPayload;
    expect(family_name).toBeDefined();
    expect(sessionPayloadSchema.safeParse(missingFamilyName).success).toBe(
      false
    );
  });
});
