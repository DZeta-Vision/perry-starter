// The AuthErrorResponse code state machine — the SINGLE source mapping each
// server-issued auth code to exactly ONE UX treatment.
//
// The cloud authority is the sole authn/authz decider; this module never decides
// auth — it only REFLECTS a server-issued code into one unambiguous surface. The
// mapping is total (every code maps) and injective into distinct treatments (no
// code maps to two screens, no two codes collapse to one), so a code can never
// fall through to a blank/404 nor leave the surface ambiguous.

export const AUTH_ERROR_CODES = [
  "UNAUTHORIZED",
  "SESSION_EXPIRED",
  "EMAIL_NOT_VERIFIED",
  "PASSWORD_CHANGE_REQUIRED",
  "TWO_FACTOR_REQUIRED",
  "STEP_UP_REQUIRED",
  "ACCOUNT_LOCKED",
  "FORBIDDEN",
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

// The eight mutually-distinct UX treatments. Each value doubles as the stable
// `data-auth-treatment` marker the surfaces stamp for the coverage map.
export type AuthTreatment =
  | "sign-in"
  | "session-expired"
  | "verify-email"
  | "forced-password-change"
  | "two-factor"
  | "step-up"
  | "account-locked"
  | "no-access";

// The total, injective code -> treatment map. Declared as a Record over the code
// union so the type checker rejects a missing or misspelled code.
const CODE_TO_TREATMENT: Record<AuthErrorCode, AuthTreatment> = {
  UNAUTHORIZED: "sign-in",
  SESSION_EXPIRED: "session-expired",
  EMAIL_NOT_VERIFIED: "verify-email",
  PASSWORD_CHANGE_REQUIRED: "forced-password-change",
  TWO_FACTOR_REQUIRED: "two-factor",
  STEP_UP_REQUIRED: "step-up",
  ACCOUNT_LOCKED: "account-locked",
  FORBIDDEN: "no-access",
};

export const treatmentForCode = (code: AuthErrorCode): AuthTreatment =>
  CODE_TO_TREATMENT[code];

// The in-app route each treatment resolves to. The two placeholders
// (two-factor / step-up) point at DEFINED routes whose backends land later;
// they are reachable, non-trap stubs with a forward path — never a dead-end.
export const TREATMENT_ROUTE: Record<AuthTreatment, string> = {
  "sign-in": "/login",
  "session-expired": "/login",
  "verify-email": "/verify-email",
  "forced-password-change": "/change-password",
  "two-factor": "/two-factor",
  "step-up": "/step-up",
  "account-locked": "/account-locked",
  "no-access": "/no-access",
};

const isAuthErrorCode = (value: unknown): value is AuthErrorCode =>
  typeof value === "string" &&
  (AUTH_ERROR_CODES as readonly string[]).includes(value);

// A header bag is either a Fetch `Headers` or a plain record; read it uniformly.
const readHeader = (
  headers: Headers | Record<string, string> | undefined,
  name: string
): string | undefined => {
  if (!headers) {
    return;
  }
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()];
};

export interface AuthErrorEnvelope {
  readonly body?: unknown;
  readonly headers?: Headers | Record<string, string>;
  readonly status?: number;
}

// The forced-change signal header. Its presence forces the
// PASSWORD_CHANGE_REQUIRED treatment regardless of the body code, so the gate
// mounts even when the body carries only the native FORBIDDEN.
const REQUIRE_PASSWORD_CHANGE_HEADER = "x-require-password-change";

// Resolve the precise AuthErrorResponse code from a server response envelope.
// The code rides in the body (`{ error: { code } }` or a bare `{ code }`), with
// the x-require-password-change header taking precedence (the forced-password-change contract). An
// unrecognized payload yields `undefined` so callers fall back to the generic
// treatment rather than inventing a code.
export const authCodeFromEnvelope = (
  envelope: AuthErrorEnvelope
): AuthErrorCode | undefined => {
  if (readHeader(envelope.headers, REQUIRE_PASSWORD_CHANGE_HEADER)) {
    return "PASSWORD_CHANGE_REQUIRED";
  }
  const body = envelope.body as
    | { error?: { code?: unknown }; code?: unknown }
    | undefined;
  const fromBody = body?.error?.code ?? body?.code;
  if (isAuthErrorCode(fromBody)) {
    return fromBody;
  }
  return;
};
