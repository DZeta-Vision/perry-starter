import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { NoAccess } from "@/components/auth/treatment-surfaces";

export const Route = createFileRoute("/no-access")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  return <NoAccess onForward={() => navigate({ to: "/login" })} />;
}
