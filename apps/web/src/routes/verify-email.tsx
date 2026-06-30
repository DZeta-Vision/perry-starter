import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { VerificationWall } from "@/components/auth/treatment-surfaces";

export const Route = createFileRoute("/verify-email")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  return <VerificationWall onForward={() => navigate({ to: "/login" })} />;
}
