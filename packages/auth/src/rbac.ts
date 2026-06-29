// The public RBAC facade for the two-layer authorization perimeter.
//
// It re-exports the ONE single-sourced matrix (`ac` / `roles` / the numeric
// hierarchy) built in ./index and projects the tRPC-middleware leg's
// role->capability map. Both legs (this middleware projection AND the SurrealDB
// row-PERMISSIONS projection in ./permissions-gen) derive from the SAME
// `ac.statements`, so the role-parity gate proves they cannot drift.
//
// No second `createAccessControl` is built here — the single source is ./index.

import {
  ac as accessControl,
  APP_ROLE_RANK as appRoleRank,
  roles as roleMatrix,
} from "./index";
import {
  type CapabilityMap,
  escalationPredicateFor as escalationPredicateForImpl,
  permissionsCapabilityMap as permissionsCapabilityMapImpl,
  permissionsMapForClaim as permissionsMapForClaimImpl,
  resolveGlobalRoles as resolveGlobalRolesImpl,
} from "./permissions-gen";

export type { CapabilityMap, GlobalRolePrincipal } from "./permissions-gen";

// Re-expose the ONE single-sourced matrix + the row-PERMISSIONS leg as the
// facade's surface. New bindings (not `export … from`) keep this a real module,
// not a barrel — both legs and the tests read this one import surface.
export const ac = accessControl;
export const roles = roleMatrix;
export const APP_ROLE_RANK = appRoleRank;
export const resolveGlobalRoles = resolveGlobalRolesImpl;
export const permissionsCapabilityMap = permissionsCapabilityMapImpl;
export const permissionsMapForClaim = permissionsMapForClaimImpl;
export const escalationPredicateFor = escalationPredicateForImpl;

// The single statement object both legs derive from (the resolved `ac.statements`).
export const statement = accessControl.statements;

type Tier = "member" | "admin" | "superadmin";
const TIERS: readonly Tier[] = ["member", "admin", "superadmin"];

interface ResolvedRole {
  readonly authorize: (
    request: Record<string, readonly string[]>,
    connector?: "AND" | "OR"
  ) => { readonly success: boolean };
  readonly statements: Record<string, readonly string[]>;
}
const ROLES = roles as unknown as Record<Tier, ResolvedRole>;

// The tRPC-middleware leg's role->capability projection (the authorize side).
// Byte-equal to permissionsCapabilityMap() because both read roles[*].statements.
export const middlewareCapabilityMap = (): CapabilityMap => {
  const map = {} as CapabilityMap;
  for (const tier of TIERS) {
    const projected: Record<string, string[]> = {};
    for (const [resource, actions] of Object.entries(ROLES[tier].statements)) {
      projected[resource] = [...actions];
    }
    map[tier] = projected;
  }
  return map;
};

export interface ParityResult {
  readonly drifts: readonly string[];
  readonly parity: boolean;
}

// Pure parity checker: the two role->capability maps agree iff, for every
// (tier, resource), the action sets are equal. Anti-vacuous by construction — it
// reports drift the moment one leg adds/drops a capability.
export const roleParity = (
  middleware: CapabilityMap,
  permissions: CapabilityMap
): ParityResult => {
  const drifts: string[] = [];
  const left = middleware as Record<string, Record<string, readonly string[]>>;
  const right = permissions as Record<
    string,
    Record<string, readonly string[]>
  >;
  const tiers = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const tier of tiers) {
    const a = left[tier] ?? {};
    const b = right[tier] ?? {};
    const resources = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const resource of resources) {
      const av = [...(a[resource] ?? [])].sort();
      const bv = [...(b[resource] ?? [])].sort();
      if (av.length !== bv.length || av.some((x, i) => x !== bv[i])) {
        drifts.push(`${tier}.${resource}`);
      }
    }
  }
  return { parity: drifts.length === 0, drifts };
};

// Whether a tier holds the superadmin-only `user:set-role` capability.
const holdsSetRole = (tier: Tier): boolean =>
  (ROLES[tier].statements.user ?? []).includes("set-role");

// Role assignment is superadmin-only AND the numeric hierarchy forbids
// self-elevation: a requester can never grant a tier at or above its own.
export const canAssignRole = (requester: Tier, target: Tier): boolean =>
  holdsSetRole(requester) && APP_ROLE_RANK[target] < APP_ROLE_RANK[requester];
