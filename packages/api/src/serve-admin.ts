// The admin/compliance tRPC fetch handler — the served surface.
//
// This lives in @perry-starter/api (the tRPC-owning package) so the fetch adapter
// wiring is type-checked here and the host (the gatekeeper Worker) stays thin glue
// that only maps its env to the SurrealDB forwarder config. The handler builds the
// unified context with the host's runtime SurrealDB binding, so the injected sinks
// are live where this runs; served on the gatekeeper Worker (the sole binding
// holder), the privileged surface is real end-to-end.

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { type AdminSurrealConfig, buildAdminContext } from "./context";
import { appRouter } from "./routers/index";

// The tRPC endpoint prefix. Procedure paths ride `${prefix}/<path>`; distinct from
// the better-auth ingress (`/api/auth/*`), so the two never collide.
export const ADMIN_TRPC_PREFIX = "/api/trpc";

// True for the admin tRPC surface paths (the endpoint and any procedure under it), so
// the host routes them here BEFORE the better-auth ingress catch-all.
export const isAdminTrpcPath = (pathname: string): boolean =>
  pathname === ADMIN_TRPC_PREFIX ||
  pathname.startsWith(`${ADMIN_TRPC_PREFIX}/`);

// Serve the mounted `appRouter` with a context built from the host's real SurrealDB
// binding — so the injected sinks are live and the privileged surface runs
// end-to-end where the forwarder is.
export const serveAdminTrpc = (
  request: Request,
  surreal: AdminSurrealConfig
): Promise<Response> =>
  fetchRequestHandler({
    createContext: ({ req }) => buildAdminContext({ req, surreal }),
    endpoint: ADMIN_TRPC_PREFIX,
    req: request,
    router: appRouter,
  });
