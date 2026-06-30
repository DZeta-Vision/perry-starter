// Red-phase ATDD acceptance scaffolds for Story 2.3 — the single-sourced
// role->capability matrix and the GLOBAL-vs-org role split.
//
// RED PHASE: every test is `test.skip`. The single-sourced matrix
// (`@perry-starter/auth/rbac`: `ac`, `roles`, `statement`), the PERMISSIONS-
// generation helper, and the global-role resolver DO NOT EXIST yet (they land
// with stories 2-1/2-3). All imports of not-yet-existing modules are dynamic,
// function-indirected, and INSIDE the skipped bodies; top-level static imports
// are limited to `vitest`. `vitest run --project node` collects these as
// skipped (exit 0) — the suite stays green until the dev un-skips at green
// phase and converts the parity scaffold into the `*.gate.test.ts` + paired
// `*.mutation.test.ts` twin enforced by `scripts/meta-gate.mjs`.
//
// Behavior asserted (names describe the behavior, never an AC/risk id):
//  - both enforcement legs derive from the ONE createAccessControl().statements
//  - the role is taken from the GLOBAL user.role claim split on ',', never the
//    org member.role (the canonical mis-split)
//  - role assignment is superadmin-only and the hierarchy forbids self-elevation

import { describe, expect, test } from "vitest";

// GREEN PHASE: the single-sourced matrix and its derivation legs exist, so the
// scaffolds run. `acceptance` is aliased to `test` so the intent reads at each
// call site.
const acceptance = test;

// The three app-authz tiers form one GLOBAL numeric hierarchy.
const TIERS = ["member", "admin", "superadmin"] as const;
type Tier = (typeof TIERS)[number];

// Top-level regex literals (Biome: never inline a regex literal in a call).
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const GLOBAL_ROLE_CLAIM_RE = /\$auth\.role|\$token\.role|user\.role/;
const ORG_MEMBER_ROLE_RE = /member\.role/;

// The shape the not-yet-existing matrix module is expected to export. Declared
// locally (no import) so the file type-checks while the module is absent.
interface AuthorizeResponse {
  readonly error?: unknown;
  readonly success: boolean;
}
interface Role {
  readonly authorize: (
    request: Record<string, readonly string[]>,
    connector?: "AND" | "OR"
  ) => AuthorizeResponse;
  readonly statements: Record<string, readonly string[]>;
}
interface RbacModule {
  // The ONE access-control object every leg derives from.
  readonly ac: { readonly statements: Record<string, readonly string[]> };
  // True iff the requester tier may assign the target tier (superadmin-only,
  // never self-elevation).
  readonly canAssignRole: (requester: Tier, target: Tier) => boolean;
  // The tRPC leg's role->capability projection (also from ac.statements).
  readonly middlewareCapabilityMap: () => Record<
    Tier,
    Record<string, readonly string[]>
  >;
  // The row-PERMISSIONS leg's role->capability projection (consumes
  // ac.statements). Shape mirrors the tRPC leg so the two can be compared.
  readonly permissionsCapabilityMap: () => Record<
    Tier,
    Record<string, readonly string[]>
  >;
  // Resolves the app-authz tier set from a principal, splitting the GLOBAL
  // user.role claim on ',' — never the org member.role.
  readonly resolveGlobalRoles: (principal: {
    member?: { role?: string };
    user: { role?: string };
  }) => readonly string[];
  readonly roles: Record<Tier, Role>;
  readonly statement: Record<string, readonly string[]>;
}

const loadRbac = async (): Promise<RbacModule> =>
  // Dynamic + indirected so the absent module never breaks collection.
  (await import("@perry-starter/auth/rbac")) as unknown as RbacModule;

// The WIRED better-auth singleton's admin-plugin permission gate. `setRole`
// (`POST /admin/set-role`) authorizes via `hasPermission({ permissions: { user:
// ["set-role"] } })` against the SAME single-sourced ac/roles + adminRoles
// configured on the instance; `userHasPermission` exposes that exact gate, so
// driving it exercises the endpoint's authorization decision (not a re-impl).
interface PermissionDecision {
  readonly error: string | null;
  readonly success: boolean;
}
interface WiredAuthModule {
  readonly auth: {
    readonly api: {
      readonly userHasPermission: (input: {
        body: {
          role?: string;
          permissions: Record<string, readonly string[]>;
        };
      }) => Promise<PermissionDecision>;
    };
  };
}

const loadWiredAuth = async (): Promise<WiredAuthModule> =>
  (await import("@perry-starter/auth")) as unknown as WiredAuthModule;

// Drive the wired endpoint gate: may a caller holding `role` assign roles?
const wiredCanAssignRoles = (
  auth: WiredAuthModule["auth"],
  role: Tier
): Promise<PermissionDecision> =>
  auth.api.userHasPermission({
    body: { role, permissions: { user: ["set-role"] } },
  });

describe("the role->capability matrix is single-sourced across both enforcement legs", () => {
  acceptance(
    "every role's statements resolve from the one createAccessControl object",
    async () => {
      const m = await loadRbac();
      for (const tier of TIERS) {
        // Each role exposes a resolved statements map that is a subset of the one
        // ac.statements — proving it was minted from the single source.
        const role = m.roles[tier];
        expect(role).toBeDefined();
        for (const resource of Object.keys(role.statements)) {
          expect(Object.keys(m.ac.statements)).toContain(resource);
        }
      }
    }
  );

  acceptance(
    "the tRPC-middleware leg and the row-PERMISSIONS leg grant identically over the full role x capability grid",
    async () => {
      const m = await loadRbac();
      const mw = m.middlewareCapabilityMap();
      const perms = m.permissionsCapabilityMap();
      // Both projections come from the same ac.statements, so they must be
      // byte-equal. A second, independently-declared matrix fed to one leg would
      // make this diverge (the anti-vacuous twin of the parity gate).
      expect(mw).toEqual(perms);
    }
  );
});

describe("the app-authz tier is the GLOBAL user.role claim, never the org member.role", () => {
  acceptance(
    "a principal whose global user.role is 'admin,member' resolves {admin,member}, never the org role",
    async () => {
      const m = await loadRbac();
      const resolved = m.resolveGlobalRoles({
        user: { role: "admin,member" }, // GLOBAL app-authz claim
        member: { role: "owner" }, // orthogonal org-structural role (D1)
      });
      expect([...resolved].sort()).toEqual(["admin", "member"]);
      // The org-structural 'owner' is NOT an app-authz tier and must never leak in.
      expect(resolved).not.toContain("owner");
    }
  );

  acceptance(
    "the role resolver splits the comma-separated claim into discrete tiers",
    async () => {
      const m = await loadRbac();
      const resolved = m.resolveGlobalRoles({ user: { role: "member" } });
      expect([...resolved]).toEqual(["member"]);
    }
  );

  acceptance(
    "the claim-mapping / permissions-generation source reads the global role claim and never member.role for the authz tier",
    async () => {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      // The PERMISSIONS-generation source must key on the global claim
      // ($auth.role / $token.role / user.role) and must NOT read member.role for
      // the app-authz tier. Read over comment-stripped source.
      const src = readFileSync(
        join(process.cwd(), "packages", "auth", "src", "permissions-gen.ts"),
        "utf8"
      );
      const code = src
        .replace(BLOCK_COMMENT_RE, "")
        .replace(LINE_COMMENT_RE, "$1");
      const readsGlobalClaim = GLOBAL_ROLE_CLAIM_RE.test(code);
      const readsMemberRole = ORG_MEMBER_ROLE_RE.test(code);
      expect(readsGlobalClaim).toBe(true);
      expect(readsMemberRole).toBe(false);
    }
  );
});

describe("role assignment is superadmin-only and the hierarchy forbids self-elevation", () => {
  acceptance(
    "only superadmin may assign roles; member and admin cannot",
    async () => {
      const m = await loadRbac();
      // set-role is held by superadmin ONLY in the matrix.
      expect(m.roles.superadmin.statements).toHaveProperty("user");
      expect(m.roles.superadmin.statements.user).toContain("set-role");
      expect(m.roles.member.statements.user ?? []).not.toContain("set-role");
      expect(m.roles.admin.statements.user ?? []).not.toContain("set-role");
    }
  );

  acceptance(
    "a lower tier can never assign a higher-or-equal tier (no self-elevation)",
    async () => {
      const m = await loadRbac();
      expect(m.canAssignRole("member", "admin")).toBe(false);
      expect(m.canAssignRole("member", "member")).toBe(false);
      expect(m.canAssignRole("admin", "admin")).toBe(false);
      expect(m.canAssignRole("admin", "superadmin")).toBe(false);
      // Only the top tier may assign, and never to elevate itself implicitly.
      expect(m.canAssignRole("superadmin", "admin")).toBe(true);
      expect(m.canAssignRole("superadmin", "member")).toBe(true);
    }
  );

  acceptance(
    "the tRPC authorize check denies a member self-promoting to admin",
    async () => {
      const m = await loadRbac();
      const decision = m.roles.member.authorize({ user: ["set-role"] }, "AND");
      expect(decision.success).toBe(false);
    }
  );
});

describe("the wired admin.setRole endpoint gate authorizes role assignment", () => {
  acceptance(
    "the wired set-role gate grants superadmin and denies admin and member",
    async () => {
      const { auth } = await loadWiredAuth();
      // The endpoint (POST /admin/set-role) runs this exact gate before mutating a
      // role. Superadmin clears it; a non-superadmin (admin or member) is denied.
      expect((await wiredCanAssignRoles(auth, "superadmin")).success).toBe(
        true
      );
      expect((await wiredCanAssignRoles(auth, "admin")).success).toBe(false);
      expect((await wiredCanAssignRoles(auth, "member")).success).toBe(false);
    }
  );

  acceptance(
    "a superadmin may assign a strictly lower tier but never elevate itself",
    async () => {
      const { auth } = await loadWiredAuth();
      const m = await loadRbac();
      // The wired endpoint admits only superadmin to assign roles at all...
      expect((await wiredCanAssignRoles(auth, "superadmin")).success).toBe(
        true
      );
      // ...and the hierarchy the assignment composes with admits ONLY a strictly
      // lower target — superadmin->admin/member yes, superadmin->superadmin no
      // (no self-elevation), and a denied caller cannot reach the top tier.
      expect(m.canAssignRole("superadmin", "admin")).toBe(true);
      expect(m.canAssignRole("superadmin", "member")).toBe(true);
      expect(m.canAssignRole("superadmin", "superadmin")).toBe(false);
      expect(m.canAssignRole("admin", "superadmin")).toBe(false);
    }
  );
});
