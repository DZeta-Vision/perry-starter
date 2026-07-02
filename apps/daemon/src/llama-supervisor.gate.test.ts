import { expect, test } from "vitest";
import {
  buildLlamaArgs,
  type SupervisedChild,
  startLlamaSupervisor,
} from "./llama-supervisor";

// A crash surface must never leak an engine id / GGUF path / stack frame.
const LEAK_PATTERN = /llama|gguf|at object|\n\s+at /i;

// Conformance gate for the llama-server sidecar supervisor.
//
// Proves the sidecar is started HARDENED (loopback-only bind, a per-launch
// --api-key required, the model path, web UI off), reaches readiness over a
// bearer-authenticated /health poll, re-spawns on an unexpected exit, and
// surfaces a crash WITHOUT leaking an engine id or stack. The real GGUF binary is
// spike-gated, so spawn/fetch/port are injected — the supervision state machine
// is proven against a controllable stub. The twin proves the hardening checks go
// red on a non-loopback bind or a missing api-key.

interface FakeChild extends SupervisedChild {
  fireExit(): void;
}

const makeFakeSpawn = () => {
  const calls: { command: string; args: string[]; child: FakeChild }[] = [];
  const fakeSpawn = (command: string, args: string[]): SupervisedChild => {
    let exitListener: () => void = () => {
      // set on `on("exit", ...)`
    };
    const child: FakeChild = {
      on: (_event, listener) => {
        exitListener = listener;
        return child;
      },
      kill: () => {
        // no-op stub
      },
      fireExit: () => exitListener(),
    };
    calls.push({ command, args, child });
    return child;
  };
  return { fakeSpawn, calls };
};

test("buildLlamaArgs is hardened: loopback host, required api-key, model path, web UI off; never 0.0.0.0", () => {
  const args = buildLlamaArgs({
    host: "127.0.0.1",
    port: 8080,
    apiKey: "the-key",
    modelPath: "/models/model.gguf",
  });
  expect(args).toContain("--host");
  expect(args).toContain("127.0.0.1");
  expect(args).toContain("--api-key");
  expect(args).toContain("the-key");
  expect(args).toContain("-m");
  expect(args).toContain("/models/model.gguf");
  expect(args).toContain("--no-webui");
  expect(args).not.toContain("0.0.0.0");
});

test("the supervisor starts loopback+bearer, reaches readiness, re-spawns on an unexpected exit, and never leaks an engine id", async () => {
  const { fakeSpawn, calls } = makeFakeSpawn();
  const prints: string[] = [];
  let healthAuth: string | null = null;
  const fetchOk: typeof globalThis.fetch = (_input, init) => {
    healthAuth = new Headers(init?.headers).get("authorization");
    return Promise.resolve(new Response("ok", { status: 200 }));
  };

  const handle = await startLlamaSupervisor(
    { modelPath: "/models/model.gguf", print: (line) => prints.push(line) },
    {
      spawn: fakeSpawn,
      fetch: fetchOk,
      findPort: () => Promise.resolve(51_234),
    }
  );

  expect(handle.port).toBe(51_234);
  expect(handle.url).toBe("http://127.0.0.1:51234");
  expect(calls[0]?.command).toBe("llama-server");
  expect(calls[0]?.args).toContain("--api-key");
  expect(calls[0]?.args).toContain("127.0.0.1");
  // The /health poll carried the bearer.
  expect(healthAuth).toBe(`Bearer ${handle.apiKey}`);

  // Restart policy: an unexpected exit re-spawns.
  calls[0]?.child.fireExit();
  expect(calls.length).toBe(2);

  // Crash surface: normalized events only — no engine id / stack.
  expect(prints.join("")).not.toMatch(LEAK_PATTERN);

  await handle.stop();
});
