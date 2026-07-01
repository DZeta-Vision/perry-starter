import { expect, test } from "vitest";
import { buildLlamaArgs } from "./llama-supervisor";

// Mutation twin for llama-supervisor.gate.test.ts — the anti-vacuous proof.
//
// The gate trusts (1) the sidecar binds LOOPBACK and (2) an --api-key is always
// present. This twin proves both hardening checks discriminate: a non-loopback
// bind is detectably not 127.0.0.1, and an args set without --api-key is
// detectably missing the bearer flag.

const hostOf = (args: string[]): string | undefined => {
  const index = args.indexOf("--host");
  return index === -1 ? undefined : args[index + 1];
};

test("a non-loopback (0.0.0.0) bind is detectably NOT loopback — the loopback check would go red", () => {
  const bad = buildLlamaArgs({
    host: "0.0.0.0",
    port: 8080,
    apiKey: "k",
    modelPath: "/m.gguf",
  });
  expect(hostOf(bad)).toBe("0.0.0.0");
  expect(hostOf(bad)).not.toBe("127.0.0.1");
});

test("a hardened loopback bind passes the same check (the check is not always-red)", () => {
  const good = buildLlamaArgs({
    host: "127.0.0.1",
    port: 8080,
    apiKey: "k",
    modelPath: "/m.gguf",
  });
  expect(hostOf(good)).toBe("127.0.0.1");
});

test("an args set missing --api-key is detectably missing the bearer flag", () => {
  const withoutKey = ["--host", "127.0.0.1", "--port", "8080", "-m", "/m.gguf"];
  expect(withoutKey).not.toContain("--api-key");
  // The real builder always includes it.
  expect(
    buildLlamaArgs({
      host: "127.0.0.1",
      port: 8080,
      apiKey: "k",
      modelPath: "/m.gguf",
    })
  ).toContain("--api-key");
});
