import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { StepUpPlaceholder } from "@/components/auth/treatment-surfaces";

// D6 placeholder step-up route. The backend lands in Epic 5; this stub is a
// single surface (never a dialog over a dialog), non-keyboard-trap, with a
// forward path.
export const Route = createFileRoute("/step-up")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  return <StepUpPlaceholder onForward={() => navigate({ to: "/login" })} />;
}
