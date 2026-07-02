import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { assertAdminAccess } from "@/functions/assert-admin-access";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/admin")({
  component: RouteComponent,
  // Fail-closed admin checkpoint. It runs BEFORE any admin content is produced,
  // and `beforeLoad` is isomorphic — it runs on the SSR render AND on a client
  // navigation — invoking the one server-side checkpoint on both paths, so the
  // verdict is identical. Any error resolving the checkpoint denies (fail-closed),
  // and a denial routes to the generic, enumeration-silent no-access door.
  beforeLoad: async () => {
    let allow = false;
    try {
      allow = (await assertAdminAccess()).allow;
    } catch {
      allow = false;
    }
    if (!allow) {
      throw redirect({ to: "/no-access" });
    }
  },
});

function RouteComponent() {
  const trpc = useTRPC();
  // Admin data comes ONLY through the role-gated admin tier (the mis-tier guard
  // forbids reading admin data through an auth-only procedure).
  const summary = useQuery(trpc.admin.summary.queryOptions());
  return (
    <div className="space-y-4 p-4">
      <h1 className="font-bold text-2xl">Admin</h1>
      <p>Role: {summary.data?.role}</p>
    </div>
  );
}
