import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { TwoFactorPlaceholder } from "@/components/auth/treatment-surfaces";

// D6 placeholder TOTP-enrol route. The backend lands in Epic 5; this stub is
// reachable, non-keyboard-trap, and always offers a forward path.
export const Route = createFileRoute("/two-factor")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  return <TwoFactorPlaceholder onForward={() => navigate({ to: "/login" })} />;
}
