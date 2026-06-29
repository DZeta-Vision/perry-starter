import { auth } from "@perry-starter/auth";

// The Cloudflare auth host — the AD-23 gatekeeper / auth ingress. better-auth is
// the SOLE unit that issues sessions and tokens; this worker surfaces it over
// HTTPS and is the ONLY server unit that reaches cloud SurrealDB (its single
// runtime cloud SURREAL_* binding lives on this worker in the Alchemy program).
export default {
  fetch(request: Request): Promise<Response> {
    return auth.handler(request);
  },
} satisfies ExportedHandler;
