import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";

import OrgSwitcher, { type OrgSummary } from "@/components/org-switcher";
import { getUser } from "@/functions/get-user";
import { useTRPC } from "@/utils/trpc";

// Placeholder org list for the authenticated chrome; the worker serves the real
// membership list in a later epic.
const ORGS: readonly OrgSummary[] = [
  { id: "org-personal", name: "Personal Workspace" },
  { id: "org-acme", name: "Acme Inc" },
];

export const Route = createFileRoute("/dashboard")({
  component: RouteComponent,
  beforeLoad: async () => {
    const session = await getUser();
    return { session };
  },
  loader: ({ context }) => {
    if (!context.session) {
      throw redirect({
        to: "/login",
      });
    }
  },
});

function RouteComponent() {
  const { session } = Route.useRouteContext();

  const trpc = useTRPC();
  const privateData = useQuery(trpc.privateData.queryOptions());

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="font-bold text-2xl">Dashboard</h1>
        <OrgSwitcher organizations={ORGS} />
      </div>
      <p>Welcome {session?.user.name}</p>
      <p>API: {privateData.data?.message}</p>
    </div>
  );
}
