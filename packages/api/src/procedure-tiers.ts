// The procedure-tier manifest + the mis-tier guard.
//
// Every appRouter procedure is classified by the authorization tier it sits
// behind: `public` (no auth), `auth` (authenticated but NOT role-gated), or
// `admin` (role-gated to the admin surface). The build-time mis-tier guard uses
// this to forbid an admin page from fetching its data through an auth-only
// (non-role-gated) procedure — an adopter must reach admin data only through a
// role-gated tier, so a below-admin session cannot pull admin data via a tier
// that never checks the role.
//
// The manifest is kept honest by a companion conformance gate that asserts it
// classifies EXACTLY the router's real procedure paths (no untagged procedure, no
// stale entry). A new procedure that forgets its tier reddens the gate rather than
// silently defaulting to a permissive tier; and here an unclassified path is
// treated as `auth` (fail-closed) so an admin page reading it is a violation.

import { appRouter } from "./routers/index";

export type ProcedureTier = "public" | "auth" | "admin";

// The authoritative tier of every appRouter procedure path.
export const PROCEDURE_TIERS: Record<string, ProcedureTier> = {
  "admin.summary": "admin",
  healthCheck: "public",
  privateData: "auth",
};

// The flat set of the router's real procedure paths (dotted for sub-routers).
export const appRouterProcedurePaths = (): readonly string[] =>
  Object.keys(
    (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })
      ._def.procedures
  );

// Extract the tRPC procedure paths a source file consumes as data. Matches
// `trpc.<path>.<method>()` where `<path>` is the dotted procedure path and
// `<method>` is a react-query / vanilla tRPC accessor.
const PROC_REF_RE =
  /\btrpc\.([A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)*)\.(?:queryOptions|infiniteQueryOptions|mutationOptions|subscriptionOptions|useQuery|useSuspenseQuery|useMutation|useSubscription|query|mutate|subscribe)\b/g;

export const referencedProcedures = (source: string): readonly string[] => {
  const found = new Set<string>();
  for (const match of source.matchAll(PROC_REF_RE)) {
    if (match[1]) {
      found.add(match[1]);
    }
  }
  return [...found];
};

export interface AdminPageSource {
  readonly path: string;
  readonly text: string;
}

// An unclassified path is `auth` (fail-closed): an admin page reaching it is a
// violation, so forgetting to tier a new procedure cannot silently pass the guard.
const tierOf = (
  procedure: string,
  tiers: Record<string, ProcedureTier>
): ProcedureTier => tiers[procedure] ?? "auth";

// The mis-tier build guard: an admin page must fetch its data ONLY through an
// admin-tier (role-gated) procedure. Reading an auth-only (or unclassified) tier
// is a mis-tier violation. Reading a `public` procedure is harmless (not admin
// data). Returns one message per violation; empty means clean.
export const findMisTierAdminDataViolations = (
  pages: readonly AdminPageSource[],
  tiers: Record<string, ProcedureTier> = PROCEDURE_TIERS
): readonly string[] => {
  const violations: string[] = [];
  for (const page of pages) {
    for (const procedure of referencedProcedures(page.text)) {
      if (tierOf(procedure, tiers) === "auth") {
        violations.push(
          `${page.path}: admin page reads admin data via the auth-only procedure "${procedure}"`
        );
      }
    }
  }
  return violations;
};
