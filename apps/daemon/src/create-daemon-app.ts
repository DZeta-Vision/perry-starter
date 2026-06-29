import { readFileSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import fastify, { type FastifyInstance, type FastifyReply } from "fastify";

// The headless daemon's HTTP host: it serves the built TanStack Start SPA/static
// bundle same-origin over loopback. Content-type is ALWAYS set with
// `reply.type(...)` — never through the response header setter, which the
// daemon's fastify silently ignores for the content type (it would force
// application/json and drop a string body to `{}`).
//
// The SPA redirect contract is registered IN ORDER, and the order is
// load-bearing — getting it wrong shadows the local API and breaks deep-link
// refresh:
//   1. existing static assets serve their own bytes,
//   2. the `/api/**` + `/_serverFn/**` local-API namespace is allow-listed
//      through to native handlers (never rewritten),
//   3. every other path is a catch-all rewritten to the SPA shell `_shell.html`.

export interface DaemonAppConfig {
  readonly staticRoot: string;
}

const SHELL_FILE = "_shell.html";

// The local-API namespace that is allow-listed through to native handlers; it is
// never rewritten to the SPA shell.
const API_PREFIXES = ["/api/", "/_serverFn/"] as const;

// Content-type by file extension. Set via `reply.type()`.
const CONTENT_TYPE_BY_EXT = new Map<string, string>([
  [".css", "text/css"],
  [".html", "text/html"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".map", "application/json"],
  [".mjs", "text/javascript"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

const contentTypeFor = (filePath: string): string => {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) {
    return DEFAULT_CONTENT_TYPE;
  }
  return (
    CONTENT_TYPE_BY_EXT.get(filePath.slice(dot).toLowerCase()) ??
    DEFAULT_CONTENT_TYPE
  );
};

const isApiPath = (pathname: string): boolean =>
  API_PREFIXES.some((prefix) => pathname.startsWith(prefix));

const isFile = (candidate: string): boolean => {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

// Resolve a request path to a real file under the static root, refusing any path
// that would escape the root (traversal guard). Returns null when no file backs
// the request — the caller then falls through to the shell.
const resolveStaticFile = (
  staticRoot: string,
  pathname: string
): string | null => {
  const candidate = normalize(join(staticRoot, pathname));
  const rootWithSep = staticRoot.endsWith(sep)
    ? staticRoot
    : `${staticRoot}${sep}`;
  if (candidate !== staticRoot && !candidate.startsWith(rootWithSep)) {
    return null;
  }
  return isFile(candidate) ? candidate : null;
};

const pathnameOf = (url: string): string => {
  const queryStart = url.indexOf("?");
  const raw = queryStart === -1 ? url : url.slice(0, queryStart);
  try {
    return decodeURI(raw);
  } catch {
    return raw;
  }
};

export const createDaemonApp = (config: DaemonAppConfig): FastifyInstance => {
  const app = fastify();
  const shellPath = join(config.staticRoot, SHELL_FILE);

  // A hand-emitted server-sent-event stream stands in for the later AG-UI emit;
  // the content-type is the load-bearing part for this transport.
  app.get("/api/stream", (_request, reply) => {
    reply.type("text/event-stream").send('data: {"type":"ready"}\n\n');
  });

  const serveStaticOrShell = (url: string, reply: FastifyReply): void => {
    const pathname = pathnameOf(url);

    // Allow-list: a local-API request is never rewritten to the shell. With no
    // native handler registered it is a plain 404 — still not the shell.
    if (isApiPath(pathname)) {
      reply.code(404).type("application/json").send('{"error":"not_found"}');
      return;
    }

    // Existing static asset → its own bytes.
    const file = resolveStaticFile(config.staticRoot, pathname);
    if (file) {
      reply.type(contentTypeFor(file)).send(readFileSync(file));
      return;
    }

    // Catch-all → the SPA shell, so deep-link refresh hydrates the app.
    reply.type("text/html").send(readFileSync(shellPath, "utf8"));
  };

  app.get("/", (request, reply) => {
    serveStaticOrShell(request.url, reply);
  });
  app.get("/*", (request, reply) => {
    serveStaticOrShell(request.url, reply);
  });

  return app;
};
