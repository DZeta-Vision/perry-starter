// The enumeration-silent invitation surface — the ONE neutral response every
// invitation surface (create / resend / accept) returns.
//
// The invitation surfaces must never reveal whether the target email is already a
// registered/verified account or is unknown: the RESPONSE is byte-identical across
// the whole email-state matrix. This is realized by collapsing every internal
// outcome to the SAME canonical neutral envelope single-sourced in packages/db —
// the SAME envelope the sign-up / verification-resend / password-reset surfaces
// serve — so the invariance is cross-surface, not a per-surface replica.
//
// `EMAIL_NOT_VERIFIED` is a post-auth state and is unreachable here by construction:
// the neutral envelope never carries it.

import { neutralAuthEnvelope } from "@perry-starter/db/auth/neutral-response";

// A web-standard-ish response projection (status + body + header set) the
// cross-surface response-invariance gate canonicalizes and compares.
export interface SurfaceResponse {
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
}

// The internal outcome of an invitation surface operation. It is NEVER encoded into
// the response — it exists only to drive the (out-of-band) side effects and the
// audit trail. The response never branches on it.
export type InvitationOutcome =
  | "created"
  | "account-exists"
  | "resent"
  | "accepted"
  | "rejected";

// The ONE neutral response, reusing the canonical envelope's status + body + header
// set so it is byte-identical to the other pre-auth surfaces.
export const INVITATION_SURFACE_RESPONSE: SurfaceResponse = {
  body: neutralAuthEnvelope.body,
  headers: neutralAuthEnvelope.headers,
  status: neutralAuthEnvelope.status,
};

// Map any internal outcome to the neutral response. It is a SINGLE return that
// never reads `outcome` — so an existence/state distinction can never leak. The
// mutation twin supplies a revealing variant (which DOES branch) and proves the
// gate reddens on it, so this single-return is load-bearing.
export const invitationSurfaceResponse = (
  _outcome: InvitationOutcome
): SurfaceResponse => INVITATION_SURFACE_RESPONSE;
