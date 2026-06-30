import { env } from "@perry-starter/env/server";
import { createFileRoute } from "@tanstack/react-router";

// The web app is NOT the auth authority. better-auth lives ONLY on the
// apps/worker gatekeeper; this same-origin route is a thin relay
// that forwards `/api/auth/*` to that gatekeeper (BETTER_AUTH_URL). The browser
// auth client calls this relay; the relay never issues a session or token.
const forward = (request: Request): Promise<Response> => {
  const incoming = new URL(request.url);
  const target = new URL(
    `${incoming.pathname}${incoming.search}`,
    env.BETTER_AUTH_URL
  );
  return fetch(new Request(target, request));
};

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => forward(request),
      POST: ({ request }) => forward(request),
    },
  },
});
