import { join } from "node:path";
import { preflightBindCheck } from "./bind-check";
import { createDaemonApp } from "./create-daemon-app";
import { registerDocumentsRead } from "./documents-read";
import { reportDaemonError } from "./sentry-reporter";
import { startSupervisor } from "./supervisor";

// The daemon compile entry: preflight the UI port, supervise the `surreal`
// sidecar, serve the built SPA bundle same-origin over loopback, and print the
// loopback URL on start.
//
// v1 deliberately ships NO system tray and NO native chrome — the user runs one
// native binary and opens one printed URL in their real browser. The richer
// launch model (tray / auto-open) is an acknowledged, deferred gap, not built
// here.
//
// The per-launch bearer is delivered out-of-band via the printed URL; its
// enforcement is layered on by the loopback security baseline, not here.

const LOOPBACK = "127.0.0.1";
const SURREAL_NS = "perry";
const SURREAL_DB = "perry";

const uiPort = Number(process.env.PERRY_UI_PORT ?? "5173");
const staticRoot =
  process.env.PERRY_STATIC_ROOT ??
  join(process.cwd(), "apps", "web", "dist", "client");
const appDataDir =
  process.env.PERRY_DATA_DIR ?? join(process.cwd(), ".perry", "data");

const main = async (): Promise<void> => {
  const preflight = await preflightBindCheck(uiPort, LOOPBACK);
  if (!preflight.ok && preflight.error) {
    process.stdout.write(
      `${preflight.error.message}\n${preflight.error.fix}\n`
    );
    process.exitCode = 1;
    return;
  }

  const sidecar = await startSupervisor({
    backend: "memory",
    dataDir: appDataDir,
    print: (line) => process.stdout.write(`${line}\n`),
  });

  const app = createDaemonApp({ staticRoot });
  registerDocumentsRead(app, {
    url: sidecar.url,
    ns: SURREAL_NS,
    db: SURREAL_DB,
  });

  await app.listen({ host: LOOPBACK, port: uiPort });
  process.stdout.write(`Perry app ready at http://${LOOPBACK}:${uiPort}\n`);
};

main().catch((error: unknown) => {
  process.stdout.write(`daemon failed to start: ${String(error)}\n`);
  // Report the startup failure via the hand-rolled Sentry envelope (structured
  // stderr always; ingest POST when a DSN is configured) — never re-throwing.
  const asError = error instanceof Error ? error : new Error(String(error));
  reportDaemonError(asError).catch(() => undefined);
  process.exitCode = 1;
});
