// Shared, PURE response-security primitives — importable by BOTH the cloud
// Worker/relay tier (per-response nonce-CSP) AND the daemon's static SPA serve
// (static/hash CSP fallback, no per-request nonce). This module has NO imports
// and reads no environment: it is a set of constants + pure builders so the two
// delivery surfaces derive the SAME header contract from ONE source and cannot
// silently drift.

// The Cloudflare Turnstile challenge origin. It MUST be named in the CSP on both
// surfaces so the CAPTCHA widget's script/iframe still loads once the CAPTCHA
// tier engages — a blunt CSP that omits it is the most common "CAPTCHA won't
// render" regression.
export const TURNSTILE_CHALLENGE_HOST = "https://challenges.cloudflare.com";

// The always-on static header set — identical on success, error, and redirect,
// on both the Worker and the daemon. Values are the concrete, load-bearing
// strings the security baseline mandates; a gate asserts each verbatim.
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
};

// The Content-Security-Policy response header name — the ninth header, built
// per-surface (nonce variant vs static fallback) rather than a fixed constant.
export const CONTENT_SECURITY_POLICY_HEADER = "Content-Security-Policy";

// Build the Content-Security-Policy value.
//   - With a `nonce` (the SSR/Worker tier can mint one per response): the
//     `script-src` carries `'nonce-<nonce>'` so ONLY the inline script bearing
//     that exact nonce is authorized.
//   - Without a nonce (the daemon's prebuilt static SPA shell has no per-request
//     SSR to mint or thread one): a static fallback that authorizes same-origin
//     scripts. Either way the Turnstile host is named for the CAPTCHA widget.
export const buildContentSecurityPolicy = (
  options: { readonly nonce?: string } = {}
): string => {
  const nonce = options.nonce;
  const scriptSrc =
    nonce && nonce.length > 0
      ? `'self' 'nonce-${nonce}' ${TURNSTILE_CHALLENGE_HOST}`
      : `'self' ${TURNSTILE_CHALLENGE_HOST}`;
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    `frame-src ${TURNSTILE_CHALLENGE_HOST}`,
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
};

// A case-insensitive header reader — matches both the Web `Headers` object
// (Worker) and any adapter over a plain header record (the daemon's fastify
// inject response lowercases names).
export interface HeaderReader {
  get(name: string): string | null | undefined;
}

// Pure conformance predicate shared by the gate AND its mutation twin: it
// returns the list of required security headers that are MISSING or hold the
// wrong value on a given response. Empty ⇒ the full set landed. A gate asserts
// emptiness on success/error/redirect; the twin drops one header and asserts the
// SAME predicate reports it — proving the check is not vacuous.
export const missingSecurityHeaders = (headers: HeaderReader): string[] => {
  const missing: string[] = [];
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    if (headers.get(name) !== value) {
      missing.push(name);
    }
  }
  const csp = headers.get(CONTENT_SECURITY_POLICY_HEADER);
  if (!csp?.includes(TURNSTILE_CHALLENGE_HOST)) {
    missing.push(CONTENT_SECURITY_POLICY_HEADER);
  }
  return missing;
};

// True iff the CSP carries a per-response nonce token. The Worker/SSR CSP does;
// the daemon's static fallback must NOT (it cannot mint one) — the daemon gate
// asserts this is false, its twin proves a nonce'd CSP would trip that check.
export const cspHasNonce = (csp: string | null | undefined): boolean =>
  typeof csp === "string" && csp.includes("'nonce-");
