import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { AccountLocked } from "@/components/auth/treatment-surfaces";

export const Route = createFileRoute("/account-locked")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  return <AccountLocked onForward={() => navigate({ to: "/login" })} />;
}
