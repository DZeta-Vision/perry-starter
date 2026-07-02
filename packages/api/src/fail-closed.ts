// The fail-closed seam guard for the mounted admin/compliance surface.
//
// The privileged admin procedures are served on ONE tRPC surface, but their
// SurrealDB-backed sinks (the readAuditEntries / listUsers / setUserRole / …
// forwarders) are injected by the HOST that actually holds the runtime SurrealDB
// binding — the gatekeeper Worker. On any tier that does NOT hold that binding (the
// web relay), those sinks are ABSENT. A privileged procedure reached there must
// FAIL CLOSED — throw, never return unprivileged/empty data that a client could
// mistake for an authorized-but-empty result.
//
// `requireSink` is that guard: it returns the injected sink when present and throws
// a native INTERNAL_SERVER_ERROR carrying ADMIN_BACKEND_UNAVAILABLE otherwise, so a
// privileged read/write on a tier with no forwarder can never silently succeed. The
// error rides after the authorization middleware, so a below-privilege caller is
// still denied FORBIDDEN first (no capability enumeration through the sink guard).

import { TRPCError } from "@trpc/server";

// The precise code carried in shape.data.code when a privileged procedure is reached
// on a tier that has no forwarder wired — distinct from an authorization denial.
export const ADMIN_BACKEND_UNAVAILABLE = "ADMIN_BACKEND_UNAVAILABLE";

// Return the injected sink, or throw fail-closed. An absent sink is a provisioning
// gap on THIS tier (no SurrealDB forwarder), not a client error — so the nearest
// native code is INTERNAL_SERVER_ERROR and the precise code rides the cause.
export const requireSink = <T>(sink: T | undefined, name: string): T => {
  if (sink === undefined) {
    throw new TRPCError({
      cause: { code: ADMIN_BACKEND_UNAVAILABLE },
      code: "INTERNAL_SERVER_ERROR",
      message: `Admin backend not provisioned on this tier: ${name}`,
    });
  }
  return sink;
};
