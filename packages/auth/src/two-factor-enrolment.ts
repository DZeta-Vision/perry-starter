// The mandatory-2FA entry chain — a PURE, ordered, non-dismissable decision over
// (role, forced-password-change flag, TOTP-enrolment state).
//
// After the forced password change, an admin/superadmin is deterministically
// chained through mandatory TOTP enrolment, so NO admin/superadmin can operate
// without 2FA. better-auth ships the `twoFactor()` enable/verify surface but NO
// force-enrolment — that gate is this adopter-built wiring.
//
// The chain is ORDERED and non-dismissable:
//   1. `requirePasswordChange` set            -> PASSWORD_CHANGE_REQUIRED
//   2. else admin/superadmin without TOTP     -> TWO_FACTOR_REQUIRED
//   3. else                                   -> ALLOW
//
// Each gate leaves exactly ONE forward path open (change-password, then TOTP
// enrolment/challenge), so a gated account is never a dead-end; every OTHER
// operation is refused while a gate is active. The precise gate value is carried
// in the error envelope's `data.code`, never a native tRPC code.

import { holdsAdminSurface } from "./rbac";

// The gate codes (carried in `shape.data.code`, never native tRPC codes).
export const PASSWORD_CHANGE_REQUIRED_GATE = "PASSWORD_CHANGE_REQUIRED";
export const TWO_FACTOR_REQUIRED_GATE = "TWO_FACTOR_REQUIRED";

export type CredentialGate =
  | "ALLOW"
  | typeof PASSWORD_CHANGE_REQUIRED_GATE
  | typeof TWO_FACTOR_REQUIRED_GATE;

// The ONE change-password forward path (single-sourced with the forced-change
// gate). While `requirePasswordChange` is set, only this op is permitted.
export const CHANGE_PASSWORD_PATH = "auth.changePassword";
// The ONE forward path each open while TWO_FACTOR_REQUIRED is active: begin
// enrolment, or (on a later login for an already-enrolled account) answer the
// challenge. Every other op is refused until 2FA is satisfied.
export const TWO_FACTOR_ENROL_PATH = "auth.enrolTwoFactor";
export const TWO_FACTOR_CHALLENGE_PATH = "auth.verifyTwoFactor";

const TWO_FACTOR_FORWARD_PATHS: ReadonlySet<string> = new Set([
  TWO_FACTOR_ENROL_PATH,
  TWO_FACTOR_CHALLENGE_PATH,
]);

// Whether a GLOBAL role claim must carry mandatory TOTP: exactly the tiers the ONE
// matrix admits to the admin surface (admin/superadmin), derived — never a
// hand-typed literal — so it cannot drift from the checkpoint's admit decision.
export const requiresMandatoryTwoFactor = (roleClaim: string): boolean =>
  holdsAdminSurface(roleClaim);

export interface CredentialChainInput {
  readonly requirePasswordChange: boolean;
  readonly roleClaim: string;
  readonly twoFactorEnrolled: boolean;
}

// The ordered chain decision. Password change is evaluated FIRST (it blocks
// everything, including 2FA), so an admin cannot reach the 2FA step — let alone a
// privileged op — while still owing a password change; then mandatory TOTP gates
// any admin/superadmin that has not enrolled.
export const nextCredentialGate = (
  input: CredentialChainInput
): CredentialGate => {
  if (input.requirePasswordChange) {
    return PASSWORD_CHANGE_REQUIRED_GATE;
  }
  if (requiresMandatoryTwoFactor(input.roleClaim) && !input.twoFactorEnrolled) {
    return TWO_FACTOR_REQUIRED_GATE;
  }
  return "ALLOW";
};

export interface CredentialChainVerdict {
  readonly allow: boolean;
  readonly gate: CredentialGate;
}

// Evaluate the chain for a concrete requested path. A gate ALLOWS only its own
// forward path (so the chain is never a dead-end) and refuses every other op —
// proving an admin/superadmin cannot skip a step to reach a privileged operation.
export const evaluateCredentialChain = (
  input: CredentialChainInput & { readonly path: string }
): CredentialChainVerdict => {
  const gate = nextCredentialGate(input);
  if (gate === "ALLOW") {
    return { allow: true, gate };
  }
  if (gate === PASSWORD_CHANGE_REQUIRED_GATE) {
    return { allow: input.path === CHANGE_PASSWORD_PATH, gate };
  }
  return { allow: TWO_FACTOR_FORWARD_PATHS.has(input.path), gate };
};
