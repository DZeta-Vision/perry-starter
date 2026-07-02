// Mutation twin for mistier-guard.gate.test.ts.
//
// It feeds the REAL mis-tier guard known-bad admin pages and asserts each reddens,
// proving the guard is anti-vacuous: an admin page fetching admin data through an
// auth-only (or unclassified) procedure MUST fail. It also drives the good baseline
// to prove the guard stays green when the admin data comes through the admin tier.

import {
  appRouterProcedurePaths,
  findMisTierAdminDataViolations,
  PROCEDURE_TIERS,
} from "@perry-starter/api/procedure-tiers";
import { expect, test } from "vitest";

test("an admin page fetching admin data through the auth-only tier fails the guard", () => {
  const badPage = {
    path: "apps/web/src/routes/admin.tsx",
    text: `
      export const Route = createFileRoute("/admin")({
        component: RouteComponent,
      });
      function RouteComponent() {
        const trpc = useTRPC();
        // MIS-TIER: admin data pulled through the auth-only (non-role-gated) tier.
        const data = useQuery(trpc.privateData.queryOptions());
        return <div>{data.data?.message}</div>;
      }
    `,
  };
  const violations = findMisTierAdminDataViolations([badPage]);
  expect(violations.length).toBeGreaterThan(0);
  expect(violations[0]).toContain("privateData");
});

test("an admin page fetching admin data through an unclassified procedure fails the guard (fail-closed)", () => {
  const badPage = {
    path: "apps/web/src/routes/admin.tsx",
    text: "const q = useQuery(trpc.reports.export.queryOptions());",
  };
  expect(findMisTierAdminDataViolations([badPage]).length).toBeGreaterThan(0);
});

test("the good baseline stays green — an admin page reading through the admin tier has no violation", () => {
  const goodPage = {
    path: "apps/web/src/routes/admin.tsx",
    text: "const s = useQuery(trpc.admin.summary.queryOptions());",
  };
  expect(findMisTierAdminDataViolations([goodPage])).toEqual([]);
});

test("a manifest that drops a real router procedure no longer classifies every path (drift caught)", () => {
  // Simulate a manifest edit that left a real procedure untagged: the completeness
  // check the gate runs would go RED because the key sets diverge.
  const drifted = Object.fromEntries(
    Object.entries(PROCEDURE_TIERS).filter(([path]) => path !== "admin.summary")
  );
  const manifestPaths = [...Object.keys(drifted)].sort();
  const routerPaths = [...appRouterProcedurePaths()].sort();
  expect(manifestPaths).not.toEqual(routerPaths);
});
