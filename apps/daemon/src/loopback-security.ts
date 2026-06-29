import { createHash, timingSafeEqual } from "node:crypto";
import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from "fastify";

// The daemon's inbound compensating controls. Loopback is NOT a security
// boundary: despite binding 127.0.0.1 the listener can be reached from the LAN,
// so the bind is mitigated by an OS-level control (host firewall / sandbox
// profile) PLUS the two controls implemented here — a per-launch bearer token
// required on every gated request, and strict Origin/CSRF checks on
// state-changing browser requests.
//
// Origin/CSRF defends browser-driven requests only; it is NOT a LAN control. A
// non-browser client on the LAN does not send a forgeable Origin and is stopped
// by the bearer token, not by these checks. The honest residual after all
// mitigation is bearer-token strength, not network isolation.

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const BEARER_PREFIX = "Bearer ";

const SAME_ORIGIN = "same-origin";
const CSRF_HEADER = "x-csrf-token";
const CSRF_COOKIE = "perry_csrf";
// Only state-changing methods are CSRF-gated; safe (read-only) methods are not.
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Collapse a possibly-multivalued header to its first string value.
const headerValue = (raw: string | string[] | undefined): string | null => {
  if (raw === undefined) {
    return null;
  }
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
};

const extractBearer = (authorization: string | null): string | null => {
  if (authorization === null || !authorization.startsWith(BEARER_PREFIX)) {
    return null;
  }
  return authorization.slice(BEARER_PREFIX.length);
};

// Constant-time equality over fixed-length digests of both inputs. Hashing
// first means the comparison never short-circuits on length and never branches
// on the secret, closing the timing side-channel a `===`/`!==` compare opens.
const digest = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

const valuesMatch = (presented: string, valid: string): boolean =>
  timingSafeEqual(digest(presented), digest(valid));

// A fastify onRequest hook that requires the per-launch bearer on every gated
// route. A missing or mismatched token is refused with 401; only the exact
// per-launch token passes the guard.
export const bearerAuthHook =
  (launchToken: string) =>
  (
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction
  ): void => {
    const presented = extractBearer(headerValue(request.headers.authorization));
    if (presented === null || !valuesMatch(presented, launchToken)) {
      // Sending the reply without calling done() halts the request lifecycle.
      reply.code(HTTP_UNAUTHORIZED).send({ error: "unauthorized" });
      return;
    }
    done();
  };

export interface OriginCsrfOptions {
  readonly allowedOrigins: readonly string[];
}

const readCookie = (
  cookieHeader: string | null,
  name: string
): string | null => {
  if (cookieHeader === null) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
};

// A fastify preHandler hook enforcing Origin/CSRF on state-changing browser
// requests. Fetch Metadata (`Sec-Fetch-Site`) is the primary check, backed by
// an Origin allowlist; a double-submit cookie token is the fallback for clients
// that do not send Fetch Metadata. Reject → 403.
export const originCsrfHook =
  ({ allowedOrigins }: OriginCsrfOptions) =>
  (
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction
  ): void => {
    if (!STATE_CHANGING_METHODS.has(request.method)) {
      done();
      return;
    }

    const fetchSite = headerValue(request.headers["sec-fetch-site"]);
    const requestOrigin = headerValue(request.headers.origin);

    const reject = (): void => {
      reply.code(HTTP_FORBIDDEN).send({ error: "forbidden_origin" });
    };

    // Primary: a present Sec-Fetch-Site must be same-origin.
    if (fetchSite !== null && fetchSite !== SAME_ORIGIN) {
      reject();
      return;
    }
    // Origin allowlist: a present Origin must be on the loopback allow set.
    if (requestOrigin !== null && !allowedOrigins.includes(requestOrigin)) {
      reject();
      return;
    }
    // Fallback for clients without Fetch Metadata: double-submit cookie token.
    if (fetchSite === null) {
      const submitted = headerValue(request.headers[CSRF_HEADER]);
      const cookied = readCookie(
        headerValue(request.headers.cookie),
        CSRF_COOKIE
      );
      if (
        submitted === null ||
        cookied === null ||
        !valuesMatch(submitted, cookied)
      ) {
        reject();
        return;
      }
    }

    done();
  };
