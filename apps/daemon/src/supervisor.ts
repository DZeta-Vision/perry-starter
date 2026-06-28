import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";

// Supervises the `surreal` data sidecar: it assigns a loopback port, runs the
// engine with a per-app data-dir under a hardened, loopback-only profile, polls
// `/health` to readiness, re-spawns on an unexpected exit, and prints the bound
// loopback URL on start.
//
// The engine is reached ONLY as a supervised child process over loopback HTTP —
// never an in-process SDK or WASM. The in-memory backend is used in tests/CI;
// durable `surrealkv://` persistence is an operator concern, not wired here.
//
// The per-launch bearer is delivered out-of-band via the printed URL; its
// enforcement (bearer check, Origin/CSRF, egress allowlist) is layered on by the
// loopback security baseline — this module only prints.

const LOOPBACK = "127.0.0.1";
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;
const STOP_GRACE_MS = 200;

export type SidecarBackend = "memory";

export interface SupervisorConfig {
  readonly backend: SidecarBackend;
  readonly dataDir: string;
  readonly print: (line: string) => void;
}

export interface SupervisorHandle {
  readonly dataDir: string;
  // Forces the underlying sidecar to exit, to exercise the restart policy.
  readonly killSidecarForTest: () => void;
  readonly port: number;
  readonly stop: () => Promise<void>;
  readonly url: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });

const findFreePort = (): Promise<number> =>
  new Promise<number>((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, LOOPBACK, () => {
      const address = probe.address();
      if (address && typeof address === "object") {
        const { port } = address;
        probe.close(() => resolvePort(port));
      } else {
        probe.close();
        rejectPort(new Error("could not acquire a loopback port"));
      }
    });
  });

const healthIsUp = async (url: string): Promise<boolean> => {
  try {
    const res = await fetch(`${url}/health`);
    return res.ok;
  } catch {
    return false;
  }
};

const waitForHealth = async (url: string): Promise<boolean> => {
  for (let attempt = 0; attempt < HEALTH_MAX_ATTEMPTS; attempt += 1) {
    if (await healthIsUp(url)) {
      return true;
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
};

// A per-launch root credential for the sidecar's own bootstrap/DDL path. It is
// never the application's data-access identity (that is a scoped record-access
// session), and never leaves this process.
const mintSecret = (): string => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
};

export const startSupervisor = async (
  config: SupervisorConfig
): Promise<SupervisorHandle> => {
  const port = await findFreePort();
  const url = `http://${LOOPBACK}:${port}`;
  const user = "root";
  const pass = mintSecret();

  let stopped = false;
  let child: ChildProcess | undefined;

  const spawnSidecar = (): void => {
    const proc = spawn(
      "surreal",
      [
        "start",
        "--bind",
        `${LOOPBACK}:${port}`,
        "--user",
        user,
        "--pass",
        pass,
        "--deny-guests",
        "--deny-scripting",
        "--deny-net",
        config.backend,
      ],
      { stdio: "ignore" }
    );
    proc.on("exit", () => {
      // Restart policy: re-spawn only on an unexpected exit, never after stop().
      if (!stopped) {
        spawnSidecar();
      }
    });
    child = proc;
  };

  spawnSidecar();

  const ready = await waitForHealth(url);
  if (!ready) {
    stopped = true;
    child?.kill();
    throw new Error(`surreal sidecar did not pass /health on ${url}`);
  }

  config.print(`Perry data sidecar ready at ${url}`);

  return {
    url,
    port,
    dataDir: config.dataDir,
    killSidecarForTest: () => child?.kill(),
    stop: async () => {
      stopped = true;
      child?.kill();
      await sleep(STOP_GRACE_MS);
    },
  };
};
