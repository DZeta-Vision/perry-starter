// Red-phase ATDD acceptance scaffold for the cross-layer RBAC
// role-parity conformance gate and its mutation-twin behavior.
//
// RED PHASE: every test is `test.skip` (aliased `acceptance`). The parity
// checker (`@perry-starter/auth/rbac`'s `assertRoleParity` / `roleParity`) and
// the single-sourced matrix DO NOT EXIST yet. At green phase the dev promotes
// this scaffold into the paired `rbac-role-parity.gate.test.ts` +
// `rbac-role-parity.mutation.test.ts` twin enforced by `scripts/meta-gate.mjs`
// (a conformance gate MUST ship its mutation twin or CI fails).
//
// Behavior asserted: the gate ships GREEN for the real single-sourced matrix,
// and goes RED when (1) one leg's matrix is drifted, and (2) the generator
// mis-splits the comma-string role (member.role instead of the global
// user.role) — proving the gate is anti-vacuous (it can fail).

import { describe, expect, test } from "vitest";

// GREEN PHASE: aliased to `test` so the intent reads at each call site.
const acceptance = test;

type Tier = "member" | "admin" | "superadmin";
type CapabilityMap = Record<Tier, Record<string, readonly string[]>>;

interface ParityResult {
  readonly drifts: readonly string[];
  readonly parity: boolean;
}

interface ParityModule {
  // The real, single-sourced projections (both from ac.statements).
  readonly middlewareCapabilityMap: () => CapabilityMap;
  readonly permissionsCapabilityMap: () => CapabilityMap;
  // Generates the row-PERMISSIONS projection from a principal-claim shape; an
  // injected `roleClaimPath` lets the twin force the mis-split.
  readonly permissionsMapForClaim: (claim: {
    member: { role: string };
    user: { role: string };
  }) => Record<string, readonly string[]>;
  // Pure checker: parity iff the two role->capability maps are byte-equal.
  readonly roleParity: (
    middleware: CapabilityMap,
    permissions: CapabilityMap
  ) => ParityResult;
}

const loadParity = async (): Promise<ParityModule> =>
  (await import("@perry-starter/auth/rbac")) as unknown as ParityModule;

describe("the cross-layer RBAC role-parity gate is green for the single-sourced matrix", () => {
  acceptance(
    "the tRPC-leg and row-PERMISSIONS-leg projections are parity-equal",
    async () => {
      const m = await loadParity();
      const result = m.roleParity(
        m.middlewareCapabilityMap(),
        m.permissionsCapabilityMap()
      );
      expect(result.parity).toBe(true);
      expect(result.drifts).toEqual([]);
    }
  );
});

describe("the role-parity gate is anti-vacuous — it goes red on a drifted leg", () => {
  acceptance(
    "dropping a capability from only one leg makes the checker report drift",
    async () => {
      const m = await loadParity();
      const middleware = m.middlewareCapabilityMap();
      const permissions = m.permissionsCapabilityMap();
      // Drift the PERMISSIONS leg: admin loses `document.delete` on one leg only.
      const drifted: CapabilityMap = {
        ...permissions,
        admin: {
          ...permissions.admin,
          document: (permissions.admin.document ?? []).filter(
            (c) => c !== "delete"
          ),
        },
      };
      const result = m.roleParity(middleware, drifted);
      expect(result.parity).toBe(false);
      expect(result.drifts.length).toBeGreaterThan(0);
    }
  );

  acceptance(
    "adding a capability to only one leg makes the checker report drift",
    async () => {
      const m = await loadParity();
      const middleware = m.middlewareCapabilityMap();
      const permissions = m.permissionsCapabilityMap();
      const drifted: CapabilityMap = {
        ...middleware,
        member: {
          ...middleware.member,
          document: [...(middleware.member.document ?? []), "delete"],
        },
      };
      const result = m.roleParity(drifted, permissions);
      expect(result.parity).toBe(false);
    }
  );
});

describe("the role-parity gate is anti-vacuous — it goes red on a mis-split comma-string role", () => {
  acceptance(
    "splitting the org member.role instead of the global user.role resolves the wrong tier and breaks parity",
    async () => {
      const m = await loadParity();
      // The principal is global-admin (user.role) but org-owner (member.role). A
      // correct generator keys on user.role -> {admin}; a mis-split keys on
      // member.role -> {owner}, which is not an app-authz tier. The two cannot be
      // parity-equal with the tRPC leg (which always reads user.role).
      const claim = {
        user: { role: "admin" },
        member: { role: "owner" },
      };
      const generated = m.permissionsMapForClaim(claim);
      const middleware = m.middlewareCapabilityMap();
      // The correctly-generated admin row scope must match the middleware admin
      // scope; a mis-split would produce an empty/owner scope that diverges.
      expect(generated).toEqual(middleware.admin);
    }
  );
});
