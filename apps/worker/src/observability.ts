import { configureAuthAudit } from "@perry-starter/auth/auth-audit";
import { scrubSecrets } from "@perry-starter/env/scrub";

// The gatekeeper Worker's observability wiring. The Cloudflare tier carries NO
// pino (no node:diagnostics_channel), so it emits structured JSON via `console` —
// the cloud-tier analogue of the edge's pino line and the daemon's stderr JSON.
//
// The auth authority's audit sink defaults to a no-op so the SDK-free packages
// never throw for want of wiring; the host binds the real sink at boot. This binds
// it to a structured, secret-scrubbed console emit so an operator actually sees the
// auth events (hibp fallback, verification-email dispatch) the sink records —
// event type + actor/action, never a payload or a secret (the NFR floor).

let authAuditBound = false;

export const bindWorkerAuthAudit = (): void => {
  if (authAuditBound) {
    return;
  }
  authAuditBound = true;
  configureAuthAudit((action) => {
    console.info(JSON.stringify(scrubSecrets({ action, event: "auth.audit" })));
  });
};
