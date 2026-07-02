import { withSecurityHeaders } from "@perry-starter/api/security-headers";
import { isAdminTrpcPath } from "@perry-starter/api/serve-admin";
import { auth } from "@perry-starter/auth";
import { normalizeAuthResponse } from "@perry-starter/auth/anti-enumeration";
import { isAuthSuccess } from "@perry-starter/auth/login-outcome";
import { type AdminTrpcEnv, handleAdminTrpc } from "./admin-trpc";
import { AI_FLOOR_PATH, type AiFloorEnv, handleAiFloor } from "./ai-floor";
import {
  assessLoginLockout,
  bindWorkerLockoutRecorder,
  type LockoutEnv,
  recordFailedLoginWithAlert,
  resetSubjectLockout,
  shouldRecordLoginFailure,
} from "./lockout";
import { bindWorkerAuthAudit } from "./observability";
import { type CleanupEnv, handleScheduledCleanup } from "./scheduled-cleanup";

// The strongly-consistent Durable-Object lockout counter class — re-exported here
// (the worker entrypoint) so Cloudflare can locate it; its name MUST equal the
// alchemy `className` ("LockoutCounter"). NEVER Cloudflare KV.
// biome-ignore lint/performance/noBarrelFile: a Durable Object class MUST be a named export of the Worker entrypoint module for Cloudflare to bind it.
export { LockoutCounter } from "./lockout";

// The gatekeeper Worker env: the AI-floor bindings, the runtime SurrealDB forwarder
// credential + the cleanup config knobs, and the progressive-lockout bindings (the
// DO counter namespace + the Turnstile server-side secret).
type GatekeeperEnv = AdminTrpcEnv & AiFloorEnv & CleanupEnv & LockoutEnv;

// better-auth mounts the email/password sign-in at this path; it is the ingress
// where the progressive-lockout gate runs (before delegating) and where a failed
// attempt is recorded against both perimeters (after delegating).
const SIGN_IN_EMAIL_PATH = "/api/auth/sign-in/email";

// The Cloudflare auth host — the cloud gatekeeper / auth ingress. better-auth is
// the SOLE unit that issues sessions and tokens; this worker surfaces it over
// HTTPS and is the ONLY server unit that reaches cloud SurrealDB (its single
// runtime cloud SURREAL_* binding lives on this worker in the Alchemy program).
//
// Two DISTINCT response-leg controls, applied at different scopes:
//   - `normalizeAuthResponse` is the ANTI-ENUMERATION rewrite: it neutralizes the
//     pre-auth surfaces so sign-up / verification-resend / sign-in never reveal
//     whether an email is registered or its verification state. It applies ONLY on
//     the better-auth ingress branch (not the AI floor, not thrown errors).
//   - `withSecurityHeaders` is the OUTERMOST response wrapper that attaches the
//     full OWASP header set (HSTS/XFO/nosniff/COOP/COEP/CORP/Referrer-Policy/
//     Permissions-Policy + a per-response nonce-CSP) onto EVERY response leg —
//     success, thrown error, and redirect alike, across BOTH the AI-floor and the
//     auth branches. Both are enforced HERE on the shipped ingress, not in a
//     synthetic parallel layer.
// The better-auth ingress leg, with the progressive-lockout gate spliced INTO the
// sign-in path. On a sign-in POST: (1) read the presented email + Turnstile token
// (cloned, so the body still reaches better-auth), (2) run the pre-attempt lockout
// gate against BOTH per-account + per-IP DO counters — a locked subject or an
// uncleared CAPTCHA short-circuits with the 429 + Retry-After envelope BEFORE any
// credential check, (3) otherwise delegate, and on a genuine CREDENTIAL failure (401,
// not a verification-wall 403) record the miss against both perimeters through the
// shared seam, while a SUCCESSFUL sign-in (2xx) RESETS both perimeters so a proven
// owner's ladder is cleared. All other paths pass straight to better-auth, then the
// anti-enumeration rewrite.
const handleAuthIngress = async (
  request: Request,
  env: GatekeeperEnv
): Promise<Response> => {
  const url = new URL(request.url);
  if (!(request.method === "POST" && url.pathname === SIGN_IN_EMAIL_PATH)) {
    const passthrough = await auth.handler(request);
    return await normalizeAuthResponse(request, passthrough);
  }

  // Clone so reading the body here does not consume it for better-auth.
  let email = "";
  let turnstileToken: string | undefined;
  try {
    const body = (await request.clone().json()) as {
      email?: unknown;
      turnstileToken?: unknown;
    };
    email = typeof body.email === "string" ? body.email : "";
    turnstileToken =
      typeof body.turnstileToken === "string" ? body.turnstileToken : undefined;
  } catch {
    // A non-JSON body has no subject to key on — proceed with an empty subject.
  }
  // Absent CF-Connecting-IP -> undefined, so the per-IP perimeter is SKIPPED rather
  // than sharing one `ip:` counter across every anonymous attempt.
  const remoteip = request.headers.get("CF-Connecting-IP") ?? undefined;

  const denied = await assessLoginLockout(env, {
    email,
    remoteip,
    turnstileToken,
  });
  if (denied) {
    return denied;
  }

  const response = await auth.handler(request);
  if (isAuthSuccess(response.status)) {
    // A proven credential clears the subject's ladder on BOTH perimeters, so a
    // near-miss climb never carries into the next session.
    resetSubjectLockout(env, { email, remoteip });
  } else if (shouldRecordLoginFailure(response.status)) {
    // ONLY a genuine credential miss (401) increments the DO counters (the
    // authoritative throttle); a verification-required 403 is NOT a strike. The
    // increment is awaited so the post-increment count can fire the admin alert
    // exactly once when the subject crosses the escalation boundary.
    await recordFailedLoginWithAlert(env, { email, remoteip });
  }
  return await normalizeAuthResponse(request, response);
};

const routeRequest = async (
  request: Request,
  env: GatekeeperEnv
): Promise<Response> => {
  // Bind the DO-backed lockout recorder once (idempotent) so failed logins /
  // step-ups increment the strongly-consistent counter; also logs the tunables.
  bindWorkerLockoutRecorder(env);
  // Bind the auth-authority audit sink once (idempotent) to a structured,
  // secret-scrubbed console emit — so an operator sees auth events (hibp fallback,
  // verification-email dispatch) as structured JSON instead of the silent no-op.
  bindWorkerAuthAudit();
  // The cloud AI floor is served same-origin on the gatekeeper Worker; the mounted
  // admin/compliance tRPC surface is served here too (this Worker is the sole holder
  // of the runtime SurrealDB binding, so the privileged forwarder is real); every
  // other path is the better-auth ingress (with the sign-in lockout gate).
  const url = new URL(request.url);
  if (url.pathname === AI_FLOOR_PATH) {
    return await handleAiFloor(request, env);
  }
  if (isAdminTrpcPath(url.pathname)) {
    return await handleAdminTrpc(request, env);
  }
  return await handleAuthIngress(request, env);
};

export default {
  fetch(request: Request, env: GatekeeperEnv): Promise<Response> {
    // `withSecurityHeaders` is the true OUTERMOST leg: it headers the routed
    // response on success, headers a caught error as a 500, and re-emits the set
    // onto any 3xx redirect — no branch escapes unheadered. It clones the response
    // headers, so an upstream Retry-After (the lockout envelope) is preserved.
    return withSecurityHeaders(() => routeRequest(request, env));
  },
  // The cron trigger (registered in the Alchemy program) fires here: the
  // observe-first, soft-delete-only, sessionless cleanup sweep. It runs on the
  // gatekeeper because that is the ONE unit holding the runtime SurrealDB binding.
  scheduled(
    _controller: ScheduledController,
    env: GatekeeperEnv,
    ctx: ExecutionContext
  ): void {
    ctx.waitUntil(handleScheduledCleanup(env));
  },
} satisfies ExportedHandler<GatekeeperEnv>;
