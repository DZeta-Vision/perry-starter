import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { TotpChallengeInput } from "@/components/auth/totp-challenge-input";
import { TwoFactorPlaceholder } from "@/components/auth/treatment-surfaces";

// The mandatory TOTP enrol/challenge route. The backend enrol/verify is
// spike-gated (a controllable seam), but the challenge SURFACE is real: it renders
// the WCAG 2.2 §3.3.8 code input (paste-friendly, `autocomplete="one-time-code"`,
// numeric inputmode) so an authenticator/password manager can autofill. The
// surface is reachable, non-keyboard-trap, and always offers a forward path.
export const Route = createFileRoute("/two-factor")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  return (
    <TwoFactorPlaceholder onForward={() => navigate({ to: "/login" })}>
      <TotpChallengeInput onValueChange={setCode} value={code} />
    </TwoFactorPlaceholder>
  );
}
