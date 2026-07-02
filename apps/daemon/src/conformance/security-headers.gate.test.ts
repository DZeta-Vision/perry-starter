// Conformance gate — the daemon's static SPA serve attaches the full static
// security header set to BOTH the asset response and the catch-all shell
// response, driven through the REAL `createDaemonApp` via fastify `inject()`.
// Because the daemon serves a PREBUILT shell with no per-request SSR, its CSP is
// the STATIC fallback (no per-response nonce) — the gate asserts the nonce is
// absent here (unlike the Worker) yet the Turnstile host is STILL named so the
// CAPTCHA widget loads. Paired twin: security-headers.mutation.test.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cspHasNonce,
  type HeaderReader,
  missingSecurityHeaders,
  TURNSTILE_CHALLENGE_HOST,
} from "@perry-starter/env/security-headers";
import { describe, expect, test } from "vitest";

const SHELL_MARKER = "data-perry-shell";
const SHELL_HTML = `<!doctype html><html><body data-perry-shell="1">shell</body></html>`;
const ASSET_BYTES = 'console.log("perry-app-asset");';
const CSP_HEADER = "content-security-policy";

type InjectHeaders = Record<string, string | string[] | undefined>;

interface InjectResponse {
  readonly body: string;
  readonly headers: InjectHeaders;
  readonly statusCode: number;
}

interface DaemonApp {
  readonly inject: (opts: {
    method: string;
    url: string;
  }) => Promise<InjectResponse>;
}

// Fastify lowercases header names on the inject response; adapt it to the
// case-insensitive `HeaderReader` the shared predicate consumes.
const readerOf = (headers: InjectHeaders): HeaderReader => ({
  get: (name: string) => {
    const value = headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value.join(", ");
    }
    return value ?? null;
  },
});

const dyn = (specifier: string): Promise<Record<string, unknown>> =>
  import(specifier) as Promise<Record<string, unknown>>;

const buildAppWithStaticRoot = async (): Promise<{
  app: DaemonApp;
  cleanup: () => void;
}> => {
  const root = mkdtempSync(join(tmpdir(), "perry-sec-headers-"));
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "assets", "app.js"), ASSET_BYTES, "utf8");
  writeFileSync(join(root, "_shell.html"), SHELL_HTML, "utf8");

  const mod = await dyn("../create-daemon-app");
  const createDaemonApp = mod.createDaemonApp as (deps: {
    staticRoot: string;
  }) => DaemonApp;

  return {
    app: createDaemonApp({ staticRoot: root }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

describe("the daemon static serve attaches the full static security header set", () => {
  test("the catch-all shell response carries the full header set", async () => {
    const { app, cleanup } = await buildAppWithStaticRoot();
    try {
      const res = await app.inject({ method: "GET", url: "/documents/deep" });
      expect(res.body).toContain(SHELL_MARKER);
      expect(missingSecurityHeaders(readerOf(res.headers))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("a static asset response carries the full header set", async () => {
    const { app, cleanup } = await buildAppWithStaticRoot();
    try {
      const res = await app.inject({ method: "GET", url: "/assets/app.js" });
      expect(res.body).toContain("perry-app-asset");
      expect(missingSecurityHeaders(readerOf(res.headers))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("the daemon CSP is the STATIC fallback — no per-response nonce, but STILL names the Turnstile host", async () => {
    const { app, cleanup } = await buildAppWithStaticRoot();
    try {
      const res = await app.inject({ method: "GET", url: "/documents/deep" });
      const csp = readerOf(res.headers).get(CSP_HEADER);
      // The prebuilt shell cannot receive a fresh per-request nonce.
      expect(cspHasNonce(csp)).toBe(false);
      // But the Turnstile widget's script/iframe origin is still allowed.
      expect(csp).toContain(TURNSTILE_CHALLENGE_HOST);
    } finally {
      cleanup();
    }
  });
});
