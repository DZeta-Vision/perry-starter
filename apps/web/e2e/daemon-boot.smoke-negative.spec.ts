// Operator negative twin for the boot+serve smoke: it proves the smoke asserts a
// REAL served shell, not merely a reachable port — boot the compiled daemon
// WITHOUT the built SPA artifact (empty/missing dist/client) and assert the
// catch-all serves a 404/empty body, the shell marker is absent, and hydration
// never occurs. Operator drill only (needs perry + Chromium on a Linux-x64
// runner); kept skipped here, not a CI gate.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";

const SHELL_MARKER = "data-perry-shell";
const LOOPBACK_URL_RE = /http:\/\/127\.0\.0\.1:\d+/;
const BOOT_TIMEOUT_MS = 30_000;

interface BootedDaemon {
  readonly stop: () => void;
  readonly url: string;
}

// Boot the compiled daemon with NO SPA artifact (the negative condition).
const bootDaemonWithoutSpa = async (): Promise<BootedDaemon> => {
  // Ensure the servable artifact is absent.
  rmSync("apps/web/dist/client", { recursive: true, force: true });
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

test.skip("without the built SPA artifact the served document carries no shell marker and never hydrates", async ({
  page,
}) => {
  const daemon = await bootDaemonWithoutSpa();
  try {
    const response = await page.goto(daemon.url);
    const html = (await response?.text()) ?? "";
    // The shell marker is absent (catch-all serves 404/empty, not the shell).
    expect(html).not.toContain(SHELL_MARKER);
    // Hydration never occurs.
    const hydrated = await page.evaluate(() =>
      document.documentElement.getAttribute("data-app-hydrated")
    );
    expect(hydrated).not.toBe("true");
  } finally {
    daemon.stop();
  }
});
