import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";

// Supervises the on-device `llama-server` (llama.cpp) sidecar: it assigns a
// loopback port, starts the engine bound loopback-only WITH a per-launch
// --api-key under a scoped non-root posture, polls /health to readiness,
// re-spawns on an unexpected exit, and surfaces a crash to the supervisor WITHOUT
// leaking engine ids or a stack to any user surface.
//
// The engine is reached ONLY as a supervised child over loopback HTTP + native
// fetch — never an in-process SDK or WASM. The real GGUF model build is
// spike-gated and ship-independent; `spawn`/`fetch`/the port probe are injectable
// so the supervision state machine is proven against a controllable stub without
// the real binary, while the cloud floor stays the always-available guarantee.

const LOOPBACK = "127.0.0.1";
const HEALTH_POLL_MS = 100;
const HEALTH_MAX_ATTEMPTS = 50;
const STOP_GRACE_MS = 50;

export interface LlamaArgsInput {
  readonly apiKey: string;
  readonly host: string;
  readonly modelPath: string;
  readonly port: number;
}

// Build the hardened llama-server argv: bound to the given (loopback) host, an
// api-key required, the model path, and the web UI disabled. A caller passing a
// non-loopback host is a misconfiguration the hardening gate catches.
export const buildLlamaArgs = (input: LlamaArgsInput): string[] => [
  "--host",
  input.host,
  "--port",
  String(input.port),
  "--api-key",
  input.apiKey,
  "-m",
  input.modelPath,
  "--no-webui",
];

// A minimal child handle (the real ChildProcess satisfies it; a stub can too).
export interface SupervisedChild {
  kill(): void;
  on(event: "exit", listener: () => void): unknown;
}

export interface LlamaSupervisorConfig {
  readonly modelPath: string;
  readonly print: (line: string) => void;
}

export interface LlamaSupervisorDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly findPort?: () => Promise<number>;
  readonly spawn?: (command: string, args: string[]) => SupervisedChild;
}

export interface LlamaSupervisorHandle {
  readonly apiKey: string;
  readonly killSidecarForTest: () => void;
  readonly port: number;
  readonly stop: () => Promise<void>;
  readonly url: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const defaultFindPort = (): Promise<number> =>
  new Promise((resolvePort, rejectPort) => {
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

const defaultSpawn = (command: string, args: string[]): SupervisedChild =>
  spawn(command, args, { stdio: "ignore" }) as ChildProcess;

// A per-launch bearer for the local model port (never leaves the process).
const mintApiKey = (): string => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
};

const healthIsUp = async (
  doFetch: typeof globalThis.fetch,
  url: string,
  apiKey: string
): Promise<boolean> => {
  try {
    const res = await doFetch(`${url}/health`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    return res.ok;
  } catch {
    return false;
  }
};

const waitForHealth = async (
  doFetch: typeof globalThis.fetch,
  url: string,
  apiKey: string
): Promise<boolean> => {
  for (let attempt = 0; attempt < HEALTH_MAX_ATTEMPTS; attempt += 1) {
    if (await healthIsUp(doFetch, url, apiKey)) {
      return true;
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
};

export const startLlamaSupervisor = async (
  config: LlamaSupervisorConfig,
  deps: LlamaSupervisorDeps = {}
): Promise<LlamaSupervisorHandle> => {
  const doSpawn = deps.spawn ?? defaultSpawn;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const findPort = deps.findPort ?? defaultFindPort;

  const port = await findPort();
  const url = `http://${LOOPBACK}:${port}`;
  const apiKey = mintApiKey();

  let stopped = false;
  let child: SupervisedChild | undefined;

  const spawnSidecar = (): void => {
    const proc = doSpawn(
      "llama-server",
      buildLlamaArgs({
        host: LOOPBACK,
        port,
        apiKey,
        modelPath: config.modelPath,
      })
    );
    proc.on("exit", () => {
      if (stopped) {
        return;
      }
      // Crash surface: a normalized event, never an engine id or stack.
      config.print(`${JSON.stringify({ event: "ai.sidecar.restart" })}\n`);
      spawnSidecar();
    });
    child = proc;
  };

  spawnSidecar();

  const ready = await waitForHealth(doFetch, url, apiKey);
  if (!ready) {
    stopped = true;
    child?.kill();
    // No engine id / stack — a normalized failure only.
    throw new Error("local model sidecar did not reach readiness");
  }

  config.print(`${JSON.stringify({ event: "ai.sidecar.ready" })}\n`);

  return {
    url,
    port,
    apiKey,
    killSidecarForTest: () => child?.kill(),
    stop: async () => {
      stopped = true;
      child?.kill();
      await sleep(STOP_GRACE_MS);
    },
  };
};
