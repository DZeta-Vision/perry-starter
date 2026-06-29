// The ONE canonical neutral auth envelope — single-sourced here in packages/db.
//
// Every pre-auth surface (sign-up, verification-resend) reuses this SAME frozen
// status/body/headers shape, so the post-submit response is byte-identical across
// the five-state email matrix (registered / unregistered / verified / unverified /
// pending). Drift between surfaces IS the enumeration leak; reusing one source
// forecloses it. The body is a generic i18n key that never confirms or denies that
// an email exists or its verification state — `EMAIL_NOT_VERIFIED` is a post-auth
// state and is unreachable here by construction.

export interface NeutralAuthEnvelope {
  readonly body: { readonly message: string };
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
}

// A generic "we have processed your request" key — never "already registered",
// "not found", "unverified", etc. Lingui-keyed (AD-21), resolved under the active
// catalog at render time.
const NEUTRAL_BODY = Object.freeze({ message: "auth.verification.maybe_sent" });

// Security headers attach to every (neutral) response, errors and redirects alike
// (the security-baseline OWASP-header rule), and are part of the byte-identical
// surface — every pre-auth response carries exactly this header set.
const NEUTRAL_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

export const neutralAuthEnvelope: NeutralAuthEnvelope = Object.freeze({
  body: NEUTRAL_BODY,
  headers: NEUTRAL_HEADERS,
  status: 200,
});
