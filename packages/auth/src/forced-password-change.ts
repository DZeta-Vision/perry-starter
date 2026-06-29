// The forced-password-change gate — a PURE decision over the flag + the path.
//
// A flagged account (its password must be rotated, e.g. after an admin reset or
// a credential-compromise event) is blocked from EVERY operation except
// change-password, so it is driven to a fresh password before it can do anything
// else — and the gate ALWAYS offers that one forward path, so it never becomes a
// dead-end. The decision is a pure function of injected inputs: the flag comes
// from the session, the path from the request. The tRPC middleware in
// packages/api binds it to the real session, emits the signal header on a denial,
// and throws the nearest native FORBIDDEN. The precise blocked-reason code rides
// in the error envelope's data.code (it is NOT a native tRPC code), and
// x-require-password-change is a documented response-header exception.

// The ONE permitted path while flagged — single-sourced so the gate and the
// middleware cannot disagree on which op is the forward path.
export const CHANGE_PASSWORD_PATH = "auth.changePassword";

// The signal header the middleware sets on a denial so the frontend can mount its
// non-dismissable forced-change gate.
export const REQUIRE_PASSWORD_CHANGE_HEADER = "x-require-password-change";

// The precise blocked-reason carried in the error envelope's data.code — never a
// native tRPC code.
export const PASSWORD_CHANGE_REQUIRED_CODE = "PASSWORD_CHANGE_REQUIRED";

const FORBIDDEN_HTTP_STATUS = 403;

export type ForcedPasswordChangeVerdict =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly code: string;
      readonly httpStatus: number;
      readonly signalHeader: string;
    };

// Allow iff the account is not flagged, OR the requested path is the one
// change-password forward path. Every other path while flagged is denied with a
// 403 + the signal header + the precise envelope code.
export const evaluateForcedPasswordChange = (input: {
  readonly path: string;
  readonly requirePasswordChange: boolean;
}): ForcedPasswordChangeVerdict => {
  if (!input.requirePasswordChange) {
    return { allow: true };
  }
  if (input.path === CHANGE_PASSWORD_PATH) {
    return { allow: true };
  }
  return {
    allow: false,
    code: PASSWORD_CHANGE_REQUIRED_CODE,
    httpStatus: FORBIDDEN_HTTP_STATUS,
    signalHeader: REQUIRE_PASSWORD_CHANGE_HEADER,
  };
};
