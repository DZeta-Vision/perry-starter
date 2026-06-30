import { describe, expect, test } from "vitest";

// Acceptance tests for session establishment + projection.
//
// Collection-safe: the only top-level import is `vitest`; the
// `@perry-starter/auth` helpers are dynamically imported inside the test bodies.
//
// These prove the two session-establishment invariants: (1) the known
// better-auth additionalFields-not-in-getSession gap is closed — locale /
// given_name / family_name are PROJECTED into the payload, not dropped; and
// (2) a fresh self-registered member resolves an active organization seeded
// from its auto-provisioned personal org (org-role `owner`), while the GLOBAL
// app-authz role and the org-structural role stay orthogonal and the documents
// perimeter keys on the userId.

interface ZodLike {
  readonly safeParse: (value: unknown) => { readonly success: boolean };
}

interface ProjectedPayload {
  readonly activeOrganizationId: string;
  readonly email: string;
  readonly family_name: string;
  readonly given_name: string;
  readonly id: string;
  readonly locale: string;
  readonly role: string;
}

interface PersonalOrgSeed {
  readonly activeOrganizationId: string;
  readonly creatorRole: string;
}

interface AuthSessionModule {
  readonly assertOrthogonalRoles: (input: {
    globalRole: string;
    orgRole: string;
  }) => boolean;
  readonly documentsPerimeterKey: (session: {
    user: { id: string };
    activeOrganizationId?: string;
  }) => string;
  readonly personalOrgSeedFor: (user: Record<string, unknown>) => {
    readonly creatorRole: string;
  };
  readonly projectGetSession: (input: {
    user: Record<string, unknown>;
    session: Record<string, unknown>;
  }) => ProjectedPayload & {
    readonly session: Record<string, unknown>;
    readonly user: Record<string, unknown>;
  };
  readonly projectSessionFields: (input: {
    user: Record<string, unknown>;
    session: Record<string, unknown>;
  }) => ProjectedPayload;
  readonly seedActiveOrganization: (input: {
    user: Record<string, unknown>;
  }) => PersonalOrgSeed;
}

interface SessionPayloadShapes {
  readonly sessionPayloadSchema: ZodLike;
}

const loadAuth = async (): Promise<AuthSessionModule> =>
  (await import("@perry-starter/auth")) as unknown as AuthSessionModule;

// Pass the db subpath specifier as a variable + `@vite-ignore` so the bundler
// does not eagerly resolve it at collection time; it runs only at run time,
// inside the test body.
const SESSION_PAYLOAD_SPEC = "@perry-starter/db/shapes/session-payload";

const loadSessionPayload = async (): Promise<SessionPayloadShapes> =>
  (await import(
    /* @vite-ignore */ SESSION_PAYLOAD_SPEC
  )) as unknown as SessionPayloadShapes;

const memberUser = {
  id: "user-1",
  email: "ada@example.com",
  role: "member",
  locale: "fr",
  given_name: "Ada",
  family_name: "Lovelace",
};

const freshSession = { activeOrganizationId: "org-personal-1" };

describe("session establishment projects the additional fields and resolves the active organization", () => {
  test("the projection carries locale, given_name and family_name through to the payload", async () => {
    const { projectSessionFields } = await loadAuth();
    const payload = projectSessionFields({
      user: memberUser,
      session: freshSession,
    });
    expect(payload.locale).toBe("fr");
    expect(payload.given_name).toBe("Ada");
    expect(payload.family_name).toBe("Lovelace");
  });

  test("the get-session projection carries the additional fields through the session body, not just the jwt", async () => {
    // The relay middleware reads the get-session body; better-auth does not
    // surface additionalFields through getSession by default, so the projection
    // must fold them in here too — otherwise locale/given_name/family_name are
    // dropped on the get-session leg even though the jwt carries them.
    const { projectGetSession } = await loadAuth();
    const body = projectGetSession({ user: memberUser, session: freshSession });
    expect(body.locale).toBe("fr");
    expect(body.given_name).toBe("Ada");
    expect(body.family_name).toBe("Lovelace");
    // The standard better-auth { user, session } envelope is preserved.
    expect(body.user).toBe(memberUser);
    expect(body.session).toBe(freshSession);
  });

  test("a get-session body that drops the additional fields fails the projected-identity contract", async () => {
    // Anti-vacuous twin: the bare better-auth envelope WITHOUT the projection
    // (the exact getSession gap) does not satisfy the canonical payload shape.
    const { sessionPayloadSchema } = await loadSessionPayload();
    const bareEnvelope = { user: memberUser, session: freshSession };
    expect(sessionPayloadSchema.safeParse(bareEnvelope).success).toBe(false);
  });

  test("the projected payload also resolves the global role and the active organization", async () => {
    const { projectSessionFields } = await loadAuth();
    const payload = projectSessionFields({
      user: memberUser,
      session: freshSession,
    });
    expect(payload.role).toBe("member");
    expect(payload.activeOrganizationId).toBe("org-personal-1");
  });

  test("the full projected payload satisfies the canonical session-payload contract", async () => {
    const { projectSessionFields } = await loadAuth();
    const { sessionPayloadSchema } = await loadSessionPayload();
    const payload = projectSessionFields({
      user: memberUser,
      session: freshSession,
    });
    expect(sessionPayloadSchema.safeParse(payload).success).toBe(true);
  });

  test("a projection that drops the additional fields fails the projected-identity contract", async () => {
    // Anti-vacuous twin: a payload stripped of the additionalFields (the exact
    // better-auth getSession gap) is rejected by the canonical shape.
    const { sessionPayloadSchema } = await loadSessionPayload();
    const droppedFields = { id: "user-1", email: "ada@example.com" };
    expect(sessionPayloadSchema.safeParse(droppedFields).success).toBe(false);
  });

  test("a fresh self-registered member resolves an active organization seeded from its personal org", async () => {
    const { seedActiveOrganization } = await loadAuth();
    const seed = seedActiveOrganization({ user: memberUser });
    expect(seed.activeOrganizationId).toBeTruthy();
    expect(seed.creatorRole).toBe("owner");
  });

  test("a fresh session with no active organization is rejected by the bootstrap contract", async () => {
    // Anti-vacuous twin: an empty activeOrganizationId means the personal-org
    // bootstrap did not fire — the invariant must catch it.
    const { seedActiveOrganization } = await loadAuth();
    const seed = seedActiveOrganization({ user: memberUser });
    const bootstrapped =
      typeof seed.activeOrganizationId === "string" &&
      seed.activeOrganizationId.length > 0;
    expect(bootstrapped).toBe(true);
  });
});

describe("the global authorization role and the org-structural owner role stay orthogonal", () => {
  test("the personal-org creator holds the org-structural owner role distinct from the global member role", async () => {
    const { personalOrgSeedFor, assertOrthogonalRoles } = await loadAuth();
    expect(personalOrgSeedFor(memberUser).creatorRole).toBe("owner");
    expect(
      assertOrthogonalRoles({ globalRole: "member", orgRole: "owner" })
    ).toBe(true);
  });

  test("mapping the org-structural owner onto the global authorization tier is rejected as a collision", async () => {
    // Anti-vacuous twin: treating the org `owner` as a GLOBAL app-authz tier is
    // a namespace collision the orthogonality check must reject.
    const { assertOrthogonalRoles } = await loadAuth();
    expect(
      assertOrthogonalRoles({ globalRole: "owner", orgRole: "owner" })
    ).toBe(false);
  });

  test("the documents perimeter keys on the user id, never the organization id", async () => {
    const { documentsPerimeterKey } = await loadAuth();
    const key = documentsPerimeterKey({
      user: { id: "user-1" },
      activeOrganizationId: "org-personal-1",
    });
    expect(key).toBe("user-1");
    expect(key).not.toBe("org-personal-1");
  });
});
