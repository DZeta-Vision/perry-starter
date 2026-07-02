import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { StepUpSurface } from "@/components/auth/treatment-surfaces";

// The per-action step-up route. STEP_UP_REQUIRED raises the step-up modal over the
// surface as a SINGLE surface (never a dialog over a dialog); it is cancelable and
// cancel aborts ONLY the action (routed to the forward path), never the session.
// The pause/resume flow (resume exactly where the action stopped) is driven by the
// step-up controller + modal at the mutation call site; this route is the standalone
// treatment for a direct step-up navigation.
export const Route = createFileRoute("/step-up")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  return <StepUpSurface onForward={() => navigate({ to: "/login" })} />;
}
