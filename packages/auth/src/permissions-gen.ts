// Row-level PERMISSIONS generator — the SurrealDB enforcement leg of the
// two-layer RBAC perimeter. It consumes the ONE single-sourced role->capability
// matrix (`ac` / `roles` from ./index) and projects it into (a) a role->capability
// map the parity gate compares against the tRPC-middleware leg, and (b) the
// SurrealQL `FOR <op> WHERE …` escalation predicates.
//
// The app-authz tier is ALWAYS taken from the GLOBAL admin-plugin role claim,
// which the DB session reads as `$auth.role` / `$token.role` (projected from the
// user.role claim) split on ','. It is NEVER the org-structural role: splitting
// the org role for the authz tier resolves a non-app-authz value (e.g. `owner`)
// and is the canonical mis-split the conformance gate must catch.

import { parseMemberRoles, roles } from "./index";

type Tier = "member" | "admin" | "superadmin";
const TIERS: readonly Tier[] = ["member", "admin", "superadmin"];

// The GLOBAL role claim the DB session reads. The row-PERMISSIONS escalation is
// keyed on THIS claim (split on ','), never an org-structural role.
export const GLOBAL_ROLE_CLAIM = "$auth.role";
export const GLOBAL_ROLE_TOKEN_CLAIM = "$token.role";

interface ResolvedRole {
  readonly authorize: (
    request: Record<string, readonly string[]>,
    connector?: "AND" | "OR"
  ) => { readonly success: boolean };
  readonly statements: Record<string, readonly string[]>;
}
const ROLES = roles as unknown as Record<Tier, ResolvedRole>;

export type CapabilityMap = Record<Tier, Record<string, readonly string[]>>;

export interface GlobalRolePrincipal {
  readonly user: { readonly role?: string };
}

// Resolve the app-authz tier set from a principal by splitting the GLOBAL
// user.role claim on ',' — never the org role.
export const resolveGlobalRoles = (
  principal: GlobalRolePrincipal
): readonly string[] => parseMemberRoles(principal.user?.role ?? "member");

// Copy a role's resolved statements into a plain { resource: actions[] } object.
const projectRole = (
  statements: Record<string, readonly string[]>
): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(statements)) {
    out[resource] = [...actions];
  }
  return out;
};

// The row-PERMISSIONS leg's role->capability projection, generated FROM the one
// matrix (roles[tier].statements). Byte-equal to the middleware leg's projection.
export const permissionsCapabilityMap = (): CapabilityMap => {
  const map = {} as CapabilityMap;
  for (const tier of TIERS) {
    map[tier] = projectRole(ROLES[tier].statements);
  }
  return map;
};

// The row scope generated for a concrete principal claim: resolve the GLOBAL tier
// set from the claim and merge those tiers' capabilities. A generator that split
// the org role instead would resolve a non-app-authz tier and produce an
// empty/divergent scope.
export const permissionsMapForClaim = (
  claim: GlobalRolePrincipal
): Record<string, string[]> => {
  const merged: Record<string, string[]> = {};
  for (const tier of resolveGlobalRoles(claim)) {
    const role = ROLES[tier as Tier];
    if (!role) {
      continue;
    }
    for (const [resource, actions] of Object.entries(role.statements)) {
      merged[resource] = [
        ...new Set([...(merged[resource] ?? []), ...actions]),
      ];
    }
  }
  return merged;
};

// The SurrealQL row-PERMISSIONS escalation predicate for a tier set, keyed on the
// GLOBAL role claim split on ',' (string::split($auth.role, ',') CONTAINS <tier>).
export const escalationPredicateFor = (tiers: readonly string[]): string =>
  tiers
    .map(
      (tier) => `string::split(${GLOBAL_ROLE_CLAIM}, ',') CONTAINS '${tier}'`
    )
    .join(" OR ");
