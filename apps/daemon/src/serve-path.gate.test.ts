// The daemon serves the SPA same-origin over loopback via fastify, with the
// redirect contract registered IN ORDER — existing static assets first →
// allow-list `/api/**` + `/_serverFn/**` through to native handlers → catch-all
// 404 rewritten to `/_shell.html`. Wrong order shadows the local API and breaks
// deep-link refresh. The host is a side-effect-free `createDaemonApp` factory
// driven via fastify `inject()`. Paired twin: serve-path.mutation.test.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const SHELL_MARKER = "data-perry-shell";
const SHELL_HTML = `<!doctype html><html><body data-perry-shell="1">shell</body></html>`;
const ASSET_BYTES = 'console.log("perry-app-asset");';

interface InjectResponse {
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly statusCode: number;
}

interface DaemonApp {
  readonly inject: (opts: {
    method: string;
    url: string;
  }) => Promise<InjectResponse>;
}

// Function-indirected dynamic import — non-statically-analyzable specifier.
const dyn = (specifier: string): Promise<Record<string, unknown>> =>
  import(specifier) as Promise<Record<string, unknown>>;

// Build a static root with one asset + the SPA shell, then construct the host.
const buildAppWithStaticRoot = async (): Promise<{
  app: DaemonApp;
  cleanup: () => void;
}> => {
  const root = mkdtempSync(join(tmpdir(), "perry-static-"));
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "assets", "app.js"), ASSET_BYTES, "utf8");
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

describe("the daemon serves the SPA shell over loopback with the redirect contract in order", () => {
  test("an existing static asset path serves its own bytes (not the shell)", async () => {
    const { app, cleanup } = await buildAppWithStaticRoot();
    try {
      const res = await app.inject({ method: "GET", url: "/assets/app.js" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("perry-app-asset");
      expect(res.body).not.toContain(SHELL_MARKER);
    } finally {
      cleanup();
    }
  });

  test("an unknown deep path is rewritten to the SPA shell (status 200, shell body) — deep-link refresh works", async () => {
    const { app, cleanup } = await buildAppWithStaticRoot();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/documents/deep/link",
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(SHELL_MARKER);
    } finally {
      cleanup();
    }
  });

  test("an `/api/*` request is NOT rewritten to the shell — the local API is allow-listed through to the native handler", async () => {
    const { app, cleanup } = await buildAppWithStaticRoot();
    try {
      const res = await app.inject({ method: "GET", url: "/api/ping" });
      // The allow-list runs BEFORE the catch-all, so /api is never the shell.
      expect(res.body).not.toContain(SHELL_MARKER);
    } finally {
      cleanup();
    }
  });
});
