// Operator boot+serve smoke (NOT a CI gate): the compiled daemon must serve the
// SPA `_shell.html` off loopback, hydrate to the app-shell, and return the
// documents-seam read — asserted anti-vacuously (a shell marker present AND the
// hydration marker set AND the seam read returns), never a bare `response.ok()`.
//
// This runs only as an operator drill: it needs `perry` + a Playwright Chromium
// on a Linux-x64 runner, so the compiled boot+serve leg is not wired as a
// CI-blocking test (the deterministic serve-path logic it depends on is CI-gated
// by serve-path.gate). Kept skipped here.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { expect, test } from "@playwright/test";

const SHELL_MARKER = "data-perry-shell";
const LOOPBACK_URL_RE = /http:\/\/127\.0\.0\.1:\d+/;
const BOOT_TIMEOUT_MS = 30_000;

interface BootedDaemon {
  readonly stop: () => void;
  readonly url: string;
}

// Build the SPA artifact (dist/client + _shell.html), perry-compile the daemon,
// boot it, and resolve the printed loopback URL.
const bootCompiledDaemon = async (withSpa: boolean): Promise<BootedDaemon> => {
  if (withSpa) {
    execFileSync("bun", ["--filter", "web", "build"], {
      env: { ...process.env, PERRY_TARGET: "local-sidecar" },
      stdio: "ignore",
    });
  }
  execFileSync(
    "perry",
    ["compile", "apps/daemon/src/main.ts", "-o", "daemon"],
    {
      stdio: "ignore",
    }
  );

  const proc: ChildProcess = spawn("./daemon", [], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const url = await new Promise<string>((resolveUrl, rejectUrl) => {
    const timer = setTimeout(
      () => rejectUrl(new Error("daemon did not print a loopback URL in time")),
      BOOT_TIMEOUT_MS
    );
    proc.stdout?.on("data", (chunk: Buffer) => {
      const match = LOOPBACK_URL_RE.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[0]);
      }
    });
  });
  return { url, stop: () => proc.kill() };
};

test.skip("the compiled daemon serves the SPA shell off loopback and hydrates to the app-shell with a live seam read", async ({
  page,
}) => {
  const daemon = await bootCompiledDaemon(true);
  try {
    const response = await page.goto(daemon.url);
    // Anti-vacuous: the served document IS the SPA shell (not a bare 200).
    const html = (await response?.text()) ?? "";
    expect(html).toContain(SHELL_MARKER);

    // After hydration the router reports it is no longer the shell render.
    await page.waitForFunction(
      () =>
        document.documentElement.getAttribute("data-app-hydrated") === "true"
    );

    // The documents-seam read returns through the daemon's local API.
    const seam = await page.request.get(`${daemon.url}/api/documents`);
    expect(seam.ok()).toBeTruthy();
  } finally {
    daemon.stop();
  }
});
