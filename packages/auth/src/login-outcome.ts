// PURE helpers that classify a login attempt's OUTCOME and canonicalize its account
// subject — the small, testable decisions the Worker's lockout splice depends on so
// they are not untested request glue.
//
// Two properties are load-bearing for the progressive lockout:
//   1. The per-account counter must key on the CANONICAL identity, so casing or
//      surrounding whitespace can never fork one account across two counters and
//      evade its lock. (Per-IP is unaffected — an IP has no such canonical form.)
//   2. Only a genuine CREDENTIAL failure (a wrong password) may accrue a lockout
//      strike. A correct password that is merely blocked downstream (e.g. an
//      unverified email, HTTP 403) is NOT a credential miss and must never ratchet
//      the ladder — otherwise a legitimate owner locks themselves out by retrying.

// Canonicalize the account subject: trim surrounding whitespace and lowercase, so
// "  Alice@Example.com " and "alice@example.com" key the SAME per-account counter.
export const normalizeAccountSubject = (email: string): string =>
  email.trim().toLowerCase();

// better-auth answers an invalid email/password sign-in with HTTP 401 (invalid
// credentials); a correct password blocked for another reason (unverified email)
// surfaces as 403. ONLY the 401 credential miss is a lockout strike. If a future
// better-auth revision uses a different status for the credential case, widen this
// single predicate — the assumption is documented here, not scattered in glue.
export const isCredentialFailure = (status: number): boolean => status === 401;

// A successful sign-in (any 2xx) CLEARS the subject's ladder — a real owner proving
// the credential resets both perimeters. Mirrors `Response.ok` so the Worker glue
// has one named, tested predicate rather than an inline magic range.
export const isAuthSuccess = (status: number): boolean =>
  status >= 200 && status < 300;
