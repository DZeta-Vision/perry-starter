import { withSecurityHeaders } from "@perry-starter/api/security-headers";
import { auth } from "@perry-starter/auth";
import { normalizeAuthResponse } from "@perry-starter/auth/anti-enumeration";
import { AI_FLOOR_PATH, type AiFloorEnv, handleAiFloor } from "./ai-floor";
import { type CleanupEnv, handleScheduledCleanup } from "./scheduled-cleanup";

// The gatekeeper Worker env: the AI-floor bindings plus the runtime SurrealDB
// forwarder credential + the cleanup config knobs the scheduled sweep uses.
type GatekeeperEnv = AiFloorEnv & CleanupEnv;

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
const routeRequest = async (
  request: Request,
  env: GatekeeperEnv
): Promise<Response> => {
  // The cloud AI floor is served same-origin on the gatekeeper Worker; every
  // other path is the better-auth ingress.
  const url = new URL(request.url);
  if (url.pathname === AI_FLOOR_PATH) {
    return await handleAiFloor(request, env);
  }
  const response = await auth.handler(request);
  return await normalizeAuthResponse(request, response);
};

export default {
  fetch(request: Request, env: GatekeeperEnv): Promise<Response> {
    // `withSecurityHeaders` is the true OUTERMOST leg: it headers the routed
    // response on success, headers a caught error as a 500, and re-emits the set
    // onto any 3xx redirect — no branch escapes unheadered.
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
