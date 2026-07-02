// Mutation twin for admin-checkpoint.gate.test.ts.
//
// It feeds the REAL un-escapable-checkpoint guard known-bad admin routes and
// asserts each reddens: an admin route with no checkpoint, or one that inlines its
// own role decision instead of delegating to the shared checkpoint, is escapable
// and MUST be flagged. A properly guarded admin route stays green, and a non-admin
// route is never flagged — proving the guard is anti-vacuous and correctly scoped.

import { expect, test } from "vitest";
import { findUnguardedAdminRoutes } from "./admin-route-guard";

test("an admin route with no checkpoint is flagged as escapable", () => {
  const unguarded = [
    {
      path: "apps/web/src/routes/admin.tsx",
      text: `export const Route = createFileRoute("/admin")({ component: C });`,
    },
  ];
  expect(findUnguardedAdminRoutes(unguarded)).toEqual([unguarded[0].path]);
});

test("an admin route that inlines its own role check (not the shared checkpoint) is flagged", () => {
  const inlined = [
    {
      path: "apps/web/src/routes/admin.tsx",
      text: `
        export const Route = createFileRoute("/admin")({
          beforeLoad: async () => {
            const session = await getUser();
            if (session?.user.role !== "admin") throw redirect({ to: "/no-access" });
          },
        });
      `,
    },
  ];
  // It has a beforeLoad but does NOT route through the shared checkpoint.
  expect(findUnguardedAdminRoutes(inlined)).toEqual([inlined[0].path]);
});

test("a properly guarded admin route (beforeLoad delegates to the shared checkpoint) is not flagged", () => {
  const guarded = [
    {
      path: "apps/web/src/routes/admin.tsx",
      text: `
        export const Route = createFileRoute("/admin")({
          beforeLoad: async () => {
            if (!(await assertAdminAccess()).allow) throw redirect({ to: "/no-access" });
          },
        });
      `,
    },
  ];
  expect(findUnguardedAdminRoutes(guarded)).toEqual([]);
});

test("a non-admin route is never flagged even without a checkpoint (correctly scoped)", () => {
  const nonAdmin = [
    {
      path: "apps/web/src/routes/dashboard.tsx",
      text: `export const Route = createFileRoute("/dashboard")({ component: C });`,
    },
  ];
  expect(findUnguardedAdminRoutes(nonAdmin)).toEqual([]);
});
