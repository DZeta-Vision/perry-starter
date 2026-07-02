import { TRPCError } from "@trpc/server";

// The progressive-lockout 429 envelope — the SERVER side of the ACCOUNT_LOCKED
// surface the client already consumes (apps/web `auth-error.ts` reads `body.code`
// / `shape.data.code`; the account-locked treatment renders a Turnstile challenge
// + generic NON-numeric copy). Two coherent legs derive from ONE source:
//   - REST ingress (better-auth sign-in on the Worker): a raw 429 `Response`
//     carrying `{ code: "ACCOUNT_LOCKED", retryAfter }` in the JSON body + a
//     literal `Retry-After` header.
//   - tRPC procedures: a `TOO_MANY_REQUESTS` `TRPCError` (a valid tRPC code -> HTTP
//     429) carrying `ACCOUNT_LOCKED` in `shape.data.code` + `retryAfter` in
//     `shape.data` via the errorFormatter (ACCOUNT_LOCKED is NOT a valid TRPCError
//     code, so it rides the envelope, never the native code).
//
// `retryAfter` is the timed-lock window in SECONDS; the client consumes it
// SILENTLY to re-enable the form when the window passes — it is never displayed as
// a countdown. Locked and rate-limited surface IDENTICALLY as ACCOUNT_LOCKED.

// The precise envelope code the client maps to the account-locked treatment.
export const ACCOUNT_LOCKED_CODE = "ACCOUNT_LOCKED";

// The literal response-header exception (alongside x-require-password-change): the
// timed-lock window, in seconds.
export const RETRY_AFTER_HEADER = "Retry-After";

// TOO_MANY_REQUESTS maps to HTTP 429 at the tRPC pin.
export const TOO_MANY_REQUESTS_STATUS = 429;

export interface LockoutErrorData {
  readonly code: string;
  readonly retryAfter: number;
}

// The lockout failure cause carried on the TRPCError; the SHIPPED errorFormatter
// (packages/api/src/index.ts) reads it into shape.data. Modeled explicitly so the
// projection cannot drift from what is thrown.
interface LockoutCause {
  readonly code: string;
  readonly retryAfter: number;
}

// Build the tRPC-leg lockout error: the nearest native code is TOO_MANY_REQUESTS
// (-> 429); ACCOUNT_LOCKED + retryAfter ride the cause so the errorFormatter can
// surface them into shape.data.
export const buildLockoutError = (retryAfterSeconds: number): TRPCError =>
  new TRPCError({
    cause: {
      code: ACCOUNT_LOCKED_CODE,
      retryAfter: retryAfterSeconds,
    } satisfies LockoutCause,
    code: "TOO_MANY_REQUESTS",
    message: "auth.error.ACCOUNT_LOCKED",
  });

// Project a thrown error into the lockout shape.data fields. Returns the
// ACCOUNT_LOCKED code + retryAfter ONLY for a genuine lockout cause; ANY other
// error yields an EMPTY projection — so the formatter can never vacuously stamp
// ACCOUNT_LOCKED onto an unrelated error. This is the exact function the SHIPPED
// errorFormatter (packages/api/src/index.ts) folds into shape.data — so a real tRPC
// procedure that throws `buildLockoutError` surfaces ACCOUNT_LOCKED + retryAfter,
// exactly like the sibling admin/step-up codes. It is NOT wired to a throwaway
// per-leg tRPC instance.
export const lockoutDataForError = (
  error: unknown
): Partial<LockoutErrorData> => {
  if (error instanceof TRPCError) {
    const cause = error.cause as Partial<LockoutCause> | undefined;
    if (
      cause?.code === ACCOUNT_LOCKED_CODE &&
      typeof cause.retryAfter === "number"
    ) {
      return { code: cause.code, retryAfter: cause.retryAfter };
    }
  }
  return {};
};

// Build the REST-ingress lockout response: HTTP 429 with the ACCOUNT_LOCKED body
// code + retryAfter AND the literal Retry-After header. This is what the Worker's
// sign-in ingress returns on a timed lock; the client's `authCodeFromEnvelope`
// reads `body.code` and mounts the account-locked treatment.
export const buildLockoutResponse = (retryAfterSeconds: number): Response =>
  Response.json(
    { code: ACCOUNT_LOCKED_CODE, retryAfter: retryAfterSeconds },
    {
      // Response.json sets content-type: application/json; the literal Retry-After
      // header is the timed-lock window in seconds (an AD-style header exception).
      headers: { [RETRY_AFTER_HEADER]: String(retryAfterSeconds) },
      status: TOO_MANY_REQUESTS_STATUS,
    }
  );
