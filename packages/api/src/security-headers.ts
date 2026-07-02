// The OUTERMOST response-leg security wrapper for the cloud Worker / relay tier.
//
// It runs AFTER the auth/AI/render pipeline and re-emits the full security
// header set onto WHATEVER `Response` comes back — a 2xx success, a thrown error
// (caught here and turned into a headered 500), OR a 3xx redirect — so no branch
// can silently ship an unheadered response. This is the response-leg analogue of
// the audit-outermost rule on the request leg. It mints a FRESH per-response
// nonce and threads it into the CSP; a producer that renders inline scripts is
// handed that same nonce so its `<script nonce>` is the only authorized inline
// script for that exact response.

import {
  buildContentSecurityPolicy,
  STATIC_SECURITY_HEADERS,
} from "@perry-starter/env/security-headers";

// The pipeline that produces the response. It receives the per-response nonce so
// an SSR producer can stamp the SAME nonce onto its inline `<script>`. A caller
// with no inline script (e.g. the auth/AI JSON + redirect legs) simply ignores
// it — a zero-arg `() => routeRequest(...)` is assignable here.
export type SecurityHeadersProducer = (nonce: string) => Promise<Response>;

// A fresh, unguessable per-response nonce. `crypto` is a global on both the
// Cloudflare Workers runtime and modern Node — no import, no in-process SDK.
const mintNonce = (): string => crypto.randomUUID().replace(/-/g, "");

const HEADERED_ERROR_BODY = '{"error":"internal_error"}';

export const withSecurityHeaders = async (
  produce: SecurityHeadersProducer
): Promise<Response> => {
  const nonce = mintNonce();
  let res: Response;
  try {
    res = await produce(nonce);
  } catch {
    // Even a thrown error is headered — the failure branch must never skip the
    // response-leg control.
    res = new Response(HEADERED_ERROR_BODY, {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  // Some Responses carry immutable headers → clone before mutating. Cloning also
  // preserves an upstream `Location` (redirect) / `Retry-After` (lockout) header.
  const headers = new Headers(res.headers);
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  headers.set("Content-Security-Policy", buildContentSecurityPolicy({ nonce }));
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
};
