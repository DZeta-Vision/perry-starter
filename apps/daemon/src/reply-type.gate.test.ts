// The daemon's fastify silently ignores the response header setter for the
// content type (it forces application/json and drops a string body to `{}`), so
// content-type MUST be set with `reply.type(...)`. Two legs: the served HTML +
// SSE responses carry the correct content-type (via fastify `inject()`), and a
// static source-guard scans `apps/daemon/src/**` non-test sources and asserts
// ZERO uses of the ignored header setter. Paired twin: reply-type.mutation.test.ts.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/daemon/src
const HTML_CONTENT_TYPE_RE = /text\/html/;
const SSE_CONTENT_TYPE_RE = /text\/event-stream/;
// The forbidden setter (single OR double quoted), in any casing of the value.
const REPLY_HEADER_CONTENT_TYPE_RE = /reply\.header\(\s*["']content-type["']/i;

const SHELL_HTML =
  '<!doctype html><html><body data-perry-shell="1"></body></html>';

interface InjectResponse {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly statusCode: number;
}

interface DaemonApp {
  readonly inject: (opts: {
    method: string;
    url: string;
  }) => Promise<InjectResponse>;
}

const dyn = (specifier: string): Promise<Record<string, unknown>> =>
  import(specifier) as Promise<Record<string, unknown>>;

const contentTypeOf = (res: InjectResponse): string => {
  const value = res.headers["content-type"];
  return Array.isArray(value) ? value.join(",") : (value ?? "");
};

// Recursively collect every .ts source under the daemon src (excluding tests).
const collectDaemonSources = (dir: string, out: string[]): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectDaemonSources(full, out);
    } else if (
      entry.isFile() &&
      full.endsWith(".ts") &&
      !full.endsWith(".test.ts")
    ) {
      out.push(full);
    }
  }
};

const buildApp = async (): Promise<{ app: DaemonApp; cleanup: () => void }> => {
  const root = mkdtempSync(join(tmpdir(), "perry-replytype-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "_shell.html"), SHELL_HTML, "utf8");
  const mod = await dyn("./create-daemon-app");
  const createDaemonApp = mod.createDaemonApp as (deps: {
    staticRoot: string;
  }) => DaemonApp;
  return {
    app: createDaemonApp({ staticRoot: root }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

describe("the daemon sets content-type via reply.type(), never the ignored reply.header()", () => {
  test("the served SPA shell carries text/html", async () => {
    const { app, cleanup } = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(contentTypeOf(res)).toMatch(HTML_CONTENT_TYPE_RE);
    } finally {
      cleanup();
    }
  });

  test("a server-sent-event response carries text/event-stream", async () => {
    const { app, cleanup } = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/stream" });
      expect(contentTypeOf(res)).toMatch(SSE_CONTENT_TYPE_RE);
    } finally {
      cleanup();
    }
  });

  test("no daemon source sets content-type via the silently-ignored reply.header('content-type', …)", () => {
    const sources: string[] = [];
    if (statSync(HERE).isDirectory()) {
      collectDaemonSources(HERE, sources);
    }
    const offenders = sources.filter((file) =>
      REPLY_HEADER_CONTENT_TYPE_RE.test(readFileSync(file, "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});
