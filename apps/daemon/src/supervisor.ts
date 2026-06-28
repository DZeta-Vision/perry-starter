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

// The per-request DB query identity is a scoped, non-root record-access Bearer
// session bound by the tables' row-level permissions. The root credential above
// is confined to the bootstrap/DDL path — it bypasses row permissions and is
// NEVER used to authenticate an application query. This helper is the auth shape
// the query path presents; the session token comes from the record-access
// sign-in, not from any root credential.
export interface QueryAuth {
  readonly kind: "bearer";
  readonly token: string;
}

export const queryAuth = (token: string): QueryAuth => ({
  kind: "bearer",
  token,
});

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
        // `--deny-net` is VARIADIC (`--deny-net [<TARGET>...]`): it greedily
        // consumes the tokens that follow it as deny-targets until the next
        // flag. It must therefore be followed by a value-less flag, never by the
        // datastore positional — otherwise it swallows the backend token,
        // outbound net is left at its default instead of blanket-denied, and the
        // datastore silently falls back to in-memory. Ordering it before the
        // value-less deny flags makes it a true blanket net denial and keeps the
        // backend as the trailing positional.
        "--deny-net",
        "--deny-guests",
        "--deny-scripting",
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
