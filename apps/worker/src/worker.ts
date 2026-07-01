import { auth } from "@perry-starter/auth";
import { normalizeAuthResponse } from "@perry-starter/auth/anti-enumeration";
import { AI_FLOOR_PATH, type AiFloorEnv, handleAiFloor } from "./ai-floor";

// The Cloudflare auth host — the cloud gatekeeper / auth ingress. better-auth is
// the SOLE unit that issues sessions and tokens; this worker surfaces it over
// HTTPS and is the ONLY server unit that reaches cloud SurrealDB (its single
// runtime cloud SURREAL_* binding lives on this worker in the Alchemy program).
//
// `normalizeAuthResponse` is the OUTERMOST response wrapper (security-baseline:
// covers success, error, and redirect alike): it rewrites the pre-auth surfaces so
// sign-up / verification-resend / sign-in never reveal whether an email is
// registered or its verification state. Anti-enumeration is enforced HERE, on the
// shipped ingress — not in a synthetic parallel layer.
export default {
  async fetch(request: Request, env: AiFloorEnv): Promise<Response> {
    // The cloud AI floor is served same-origin on the gatekeeper
    // Worker; every other path is the better-auth ingress.
    const url = new URL(request.url);
    if (url.pathname === AI_FLOOR_PATH) {
      return await handleAiFloor(request, env);
    }
    const response = await auth.handler(request);
    return await normalizeAuthResponse(request, response);
  },
} satisfies ExportedHandler<AiFloorEnv>;
