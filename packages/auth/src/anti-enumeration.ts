// The production anti-enumeration response normalizer — the OUTERMOST wrapper.
//
// The pre-auth surfaces a not-yet-authenticated caller hits must never reveal
// whether an email is registered or its verification state. better-auth's RAW
// responses DO leak: sign-up echoes the created user (the submitted email + PII),
// and sign-in answers a registered-but-unverified account with `403
// EMAIL_NOT_VERIFIED` versus `401` for an unregistered email. This wrapper runs in
// the Worker AROUND `auth.handler` (per the security-baseline "outermost response
// wrapper covering errors+redirects" rule) and rewrites those surfaces to ONE
// state-independent shape:
//
//   - sign-up + verification-resend → the single frozen neutral envelope from
//     packages/db, BYTE-IDENTICALLY across the registered / unregistered /
//     verified / unverified / pending matrix. Password-policy rejections
//     (too-short / too-long / breached) are surfaced UNCHANGED: the screen runs
//     before the account-existence check, so they reveal nothing about the email.
//   - sign-in → all pre-auth failures (401 and 403 EMAIL_NOT_VERIFIED) collapse to
//     ONE invalid-credentials shape, so existence/verification-state never leaks; a
//     genuine 2xx success (a real session for a verified account) passes through.
//
// The POST-auth EMAIL_NOT_VERIFIED wall (an AUTHENTICATED member hitting a
// protected op) is a DIFFERENT surface and is intentionally untouched.

import { neutralAuthEnvelope } from "@perry-starter/db/auth/neutral-response";

// better-auth mounts every route under this base path (the default).
const AUTH_BASE_PATH = "/api/auth";

// Pre-auth surfaces normalized to the ONE neutral envelope. The
// request-password-reset surface is here too: better-auth already returns a
// generic message and runs a constant-work decoy for unknown emails, but its raw
// body/status differ from the canonical envelope — collapsing it here makes the
// response BYTE-IDENTICAL (status + body + headers) across the
// registered/unregistered/verified/unverified/pending matrix, reusing the SAME
// frozen envelope the other pre-auth surfaces serve.
const NEUTRALIZED_PATHS: ReadonlySet<string> = new Set([
  `${AUTH_BASE_PATH}/sign-up/email`,
  `${AUTH_BASE_PATH}/send-verification-email`,
  `${AUTH_BASE_PATH}/request-password-reset`,
]);

const SIGN_IN_PATH = `${AUTH_BASE_PATH}/sign-in/email`;

// Existence-INDEPENDENT rejection codes. The breach + length screen runs BEFORE the
// account-existence check, so these are identical whether or not the email exists —
// they reveal only that the chosen password is unacceptable, and so are surfaced to
// the caller (who must pick another password) rather than hidden behind the neutral
// envelope.
const PASSWORD_POLICY_CODES: ReadonlySet<string> = new Set([
  "PASSWORD_COMPROMISED",
  "PASSWORD_TOO_LONG",
  "PASSWORD_TOO_SHORT",
]);

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

const neutralResponse = (): Response =>
  new Response(JSON.stringify(neutralAuthEnvelope.body), {
    headers: { ...neutralAuthEnvelope.headers },
    status: neutralAuthEnvelope.status,
  });

// The ONE canonical sign-in failure. A registered-but-unverified account (which
// better-auth answers `403 EMAIL_NOT_VERIFIED`) is made byte-identical to an
// unregistered email / wrong password (`401`), so the registered-vs-unregistered
// and verified-vs-unverified distinctions are erased. The headers are the SAME
// frozen set the neutral envelope carries.
const SIGN_IN_FAILURE_BODY = Object.freeze({
  code: "INVALID_EMAIL_OR_PASSWORD",
  message: "auth.error.invalid_credentials",
});

const signInFailureResponse = (): Response =>
  new Response(JSON.stringify(SIGN_IN_FAILURE_BODY), {
    headers: { ...neutralAuthEnvelope.headers },
    status: HTTP_UNAUTHORIZED,
  });

// A non-2xx sign-up/resend response whose error code is an existence-independent
// password-policy rejection. Reads a CLONE so the original body stays intact.
const isPasswordPolicyRejection = async (
  response: Response
): Promise<boolean> => {
  if (response.ok) {
    return false;
  }
  try {
    const data = (await response.clone().json()) as { code?: unknown };
    return (
      typeof data.code === "string" && PASSWORD_POLICY_CODES.has(data.code)
    );
  } catch {
    return false;
  }
};

// Wrap a better-auth handler response in the anti-enumeration normalizer. Pure,
// web-standard Request/Response — no Worker bindings — so the conformance gate can
// drive it in-process around the real auth instance.
export const normalizeAuthResponse = async (
  request: Request,
  response: Response
): Promise<Response> => {
  const path = new URL(request.url).pathname;

  if (NEUTRALIZED_PATHS.has(path)) {
    if (await isPasswordPolicyRejection(response)) {
      return response;
    }
    return neutralResponse();
  }

  if (
    path === SIGN_IN_PATH &&
    (response.status === HTTP_UNAUTHORIZED ||
      response.status === HTTP_FORBIDDEN)
  ) {
    return signInFailureResponse();
  }

  return response;
};
