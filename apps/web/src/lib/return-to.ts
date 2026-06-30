// The open-redirect guard — a PURE same-origin in-app path-allowlist validator.
//
// A preserved `returnTo` (carried through SESSION_EXPIRED / UNAUTHORIZED
// recovery) is honored ONLY when it is a bare, root-relative path that names a
// known in-app route. Absolute URLs, scheme-bearing values (`javascript:`,
// `data:`), protocol-relative `//host` values, backslash tricks, and any path
// outside the allowlist are all rejected to the default route — so a crafted
// returnTo can never bounce the user off-origin. The control (a valid in-app
// path is preserved) and the rejections together prove the guard is non-vacuous:
// it does not simply send everything to the default route.

export const DEFAULT_ROUTE = "/";

// The same-origin in-app route allowlist. A returnTo whose pathname is not one of
// these resolves to the default route. (Mirrors the TanStack Router file routes;
// extend this set when a new navigable route lands.)
export const IN_APP_ROUTES: readonly string[] = [
  "/",
  "/dashboard",
  "/login",
  "/reset-password",
  "/change-password",
  "/verify-email",
  "/account-locked",
  "/two-factor",
  "/step-up",
  "/no-access",
  "/settings/security",
];

// Control characters (NUL, tab, newline, DEL, …) must never appear in a path.
// Checked by code point rather than a regex literal so no control character is
// embedded in source.
const LOWEST_PRINTABLE = 0x20;
const DELETE_CHAR = 0x7f;
const hasControlChar = (value: string): boolean => {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < LOWEST_PRINTABLE || code === DELETE_CHAR) {
      return true;
    }
  }
  return false;
};

const QUERY_OR_HASH_RE = /[?#]/;

// Split a candidate into its pathname (dropping query/hash) for the allowlist
// check while preserving the original value when honored.
const pathnameOf = (value: string): string => {
  const queryStart = value.search(QUERY_OR_HASH_RE);
  return queryStart === -1 ? value : value.slice(0, queryStart);
};

// Validate a returnTo. Returns the preserved path when it is a same-origin in-app
// route, else the default route. Never throws and never returns an off-origin or
// scheme-bearing value.
export const safeReturnTo = (returnTo: unknown): string => {
  if (typeof returnTo !== "string") {
    return DEFAULT_ROUTE;
  }
  const value = returnTo.trim();
  // Must be a single-slash root-relative path: rejects "" / "https://…" /
  // "javascript:…" / "data:…" / "mailto:…" (no leading slash).
  if (!value.startsWith("/")) {
    return DEFAULT_ROUTE;
  }
  // Reject protocol-relative "//host" (a leading "//" is a network-path
  // reference that browsers resolve as an absolute, off-origin URL).
  if (value.startsWith("//")) {
    return DEFAULT_ROUTE;
  }
  // Reject backslash tricks (some agents normalize "\" to "/", so "/\evil"
  // becomes "//evil") and embedded control characters.
  if (value.includes("\\") || hasControlChar(value)) {
    return DEFAULT_ROUTE;
  }
  // Allowlist the pathname; honor the full value (with its query/hash) only when
  // its route is known.
  return IN_APP_ROUTES.includes(pathnameOf(value)) ? value : DEFAULT_ROUTE;
};
