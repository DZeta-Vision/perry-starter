// HIBP breach screening on the REAL credential-setting paths — fail-OPEN, not the
// brick.
//
// better-auth's `haveIBeenPwned()` plugin wraps `ctx.password.hash` and throws
// `APIError(INTERNAL_SERVER_ERROR)` on ANY range-API fetch error — i.e. it FAILS
// CLOSED, so a pwnedpasswords.com outage 500s sign-up and bricks the only-unblocked
// action. We do NOT install that plugin. Instead a better-auth `before` middleware
// (wired in ./index) calls `screenPasswordForBreach` on the credential-setting
// paths: a known-breached password is rejected, but on an outage the screen FAILS
// OPEN (the NIST-valid password is accepted) and records `auth.hibp_fallback`.
//
// This runs on the cloud authority tier (the HIBP egress is the Worker's, never the
// daemon). The range fetcher is injectable so tests drive reachable / unreachable
// doubles without a real network call.

import { recordAuthAudit } from "./auth-audit";
import { type RangeFetch, screenPasswordAgainstHibp } from "./password-policy";

// Native `fetch` IS the production range fetcher — a `fetch` Response already
// satisfies `RangeResponse` (it has `ok` and `text()`).
const nativeRangeFetch: RangeFetch = (url, init) => fetch(url, init);

let rangeFetch: RangeFetch = nativeRangeFetch;

export const configureHibpRangeFetch = (next: RangeFetch): void => {
  rangeFetch = next;
};

export const resetHibpRangeFetch = (): void => {
  rangeFetch = nativeRangeFetch;
};

// The credential-setting paths screened on the cloud authority. Mirrors the
// haveIBeenPwned() default set for the flows perry-starter actually exposes —
// minus the fail-CLOSED throw on outage. ALL THREE run the SAME screen today:
// `/sign-up/email` (carrying `password`), `/reset-password`, and
// `/change-password` (both carrying `newPassword`); the before-hook reads
// whichever field is present and fails OPEN on a range-API outage.
export const HIBP_SCREENED_PATHS: ReadonlySet<string> = new Set([
  "/sign-up/email",
  "/change-password",
  "/reset-password",
]);

// The audit action emitted when the range API is unreachable and the screen falls
// open. Single-sourced so the worker sink and the acceptance proof agree.
export const HIBP_FALLBACK_AUDIT_ACTION = "auth.hibp_fallback";

// Screen one password. Returns whether it appeared in the breach corpus (range API
// reachable + matched). On a range-API outage it returns `breached: false` and
// records the fail-open audit, so the caller lets the NIST-valid password through.
export const screenPasswordForBreach = async (
  password: string
): Promise<{ readonly breached: boolean }> => {
  const result = await screenPasswordAgainstHibp(password, rangeFetch);
  if (result.failedOpen) {
    recordAuthAudit(HIBP_FALLBACK_AUDIT_ACTION);
  }
  return { breached: result.breached };
};
