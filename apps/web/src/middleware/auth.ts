import { env } from "@perry-starter/env/server";
import { createMiddleware } from "@tanstack/react-start";

// Resolve the current session by asking the auth authority (the apps/worker
// gatekeeper) over HTTP, forwarding the incoming credentials. The web app holds
// no auth singleton and issues no session — it only reads one.
type ResolvedSession = Record<string, unknown> | null;

export const authMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    const response = await fetch(
      new URL("/api/auth/get-session", env.BETTER_AUTH_URL),
      { headers: request.headers }
    );
    const session: ResolvedSession = response.ok
      ? ((await response.json()) as ResolvedSession)
      : null;
    return next({
      context: { session },
    });
  }
);
