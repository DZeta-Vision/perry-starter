import { ForcedPasswordChange } from "@/components/auth/forced-password-change";
import {
  AccountLocked,
  NoAccess,
  SessionExpiredTreatment,
  SignInTreatment,
  StepUpPlaceholder,
  TwoFactorPlaceholder,
  VerificationWall,
} from "@/components/auth/treatment-surfaces";
import { type AuthErrorCode, treatmentForCode } from "@/lib/auth-error";

// The 8-state AuthErrorResponse machine, rendered. Given a server-issued code it
// resolves the ONE treatment (via the total, injective code->treatment map) and
// renders exactly that surface — each surface stamps its own distinct
// `data-auth-treatment` marker, so no code is ever unmapped or ambiguous. This
// component decides nothing about auth; it only reflects the server's verdict.
export function AuthErrorSurface({
  code,
  returnTo,
  onForward,
  onResend,
  onChangePassword,
}: {
  code: AuthErrorCode;
  returnTo?: string | null;
  onForward?: () => void;
  onResend?: () => void;
  onChangePassword?: (values: { newPassword: string }) => Promise<void>;
}) {
  switch (treatmentForCode(code)) {
    case "sign-in":
      return <SignInTreatment onForward={onForward} />;
    case "session-expired":
      return <SessionExpiredTreatment returnTo={returnTo} />;
    case "verify-email":
      return <VerificationWall onForward={onForward} onResend={onResend} />;
    case "forced-password-change":
      return <ForcedPasswordChange onSubmit={onChangePassword} />;
    case "two-factor":
      return <TwoFactorPlaceholder onForward={onForward} />;
    case "step-up":
      return <StepUpPlaceholder onForward={onForward} />;
    case "account-locked":
      return <AccountLocked onForward={onForward} />;
    default:
      return <NoAccess onForward={onForward} />;
  }
}
