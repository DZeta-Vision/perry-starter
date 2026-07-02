import { serveAdminTrpc } from "@perry-starter/api/serve-admin";

// The gatekeeper Worker's thin env adapter for the admin/compliance tRPC surface.
// This Worker is the SOLE holder of the runtime SurrealDB binding (Shape C′), so it
// serves the privileged surface where the forwarder is REAL. The fetch-handler wiring
// + the unified context builder + the sink factories all live (and are gate-tested)
// in @perry-starter/api; this file only maps the Worker's env to the forwarder config.

// The subset of the gatekeeper env the served context needs: the runtime SurrealDB
// forwarder credential (present on this Worker; absent on the relay).
export interface AdminTrpcEnv {
  readonly SURREAL_DB: string;
  readonly SURREAL_NS: string;
  readonly SURREAL_PASS: string;
  readonly SURREAL_URL: string;
  readonly SURREAL_USER: string;
}

// Serve the admin router with the Worker's real SurrealDB binding.
export const handleAdminTrpc = (
  request: Request,
  env: AdminTrpcEnv
): Promise<Response> =>
  serveAdminTrpc(request, {
    db: env.SURREAL_DB,
    ns: env.SURREAL_NS,
    pass: env.SURREAL_PASS,
    url: env.SURREAL_URL,
    user: env.SURREAL_USER,
  });
