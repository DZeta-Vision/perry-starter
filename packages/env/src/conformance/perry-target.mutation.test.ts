import { expect, test } from "vitest";

// Mutation twin for perry-target.gate.test.ts — the anti-vacuous proof.
//
// Each known-bad env below MUST be rejected by the contract. If the
// PERRY_TARGET enum were ever widened to a bare string, or the strict object
// stopped rejecting unknown keys, or a SURREAL_* key became optional, the
// matching assertion here would flip from throwing to not-throwing and turn the
// twin red — exactly the failure the gate exists to prevent.

const SECRET_MIN_LENGTH = 32;
const SERVER_ENV_MODULE = "@perry-starter/env/server";

interface ServerEnvModule {
  parseServerEnv: (input: Record<string, unknown>) => unknown;
}

const validServerEnv = (): Record<string, unknown> => ({
  PERRY_TARGET: "local-sidecar",
  SURREAL_URL: "http://127.0.0.1:8000",
  SURREAL_NS: "perry",
  SURREAL_DB: "perry",
  SURREAL_USER: "root",
  SURREAL_PASS: "root",
  BETTER_AUTH_SECRET: "x".repeat(SECRET_MIN_LENGTH),
  BETTER_AUTH_URL: "http://127.0.0.1:3000",
  CORS_ORIGIN: "http://127.0.0.1:3000",
  NODE_ENV: "test",
});

const withoutKey = (input: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(input).filter(([k]) => k !== key));

test("an out-of-enum PERRY_TARGET and a missing PERRY_TARGET are both rejected", async () => {
  const mod: ServerEnvModule = await import(SERVER_ENV_MODULE);

  expect(() =>
    mod.parseServerEnv({ ...validServerEnv(), PERRY_TARGET: "nope" })
  ).toThrow();
  expect(() =>
    mod.parseServerEnv(withoutKey(validServerEnv(), "PERRY_TARGET"))
  ).toThrow();
});

test("a missing SURREAL_URL is rejected — the connection contract stays required", async () => {
  const mod: ServerEnvModule = await import(SERVER_ENV_MODULE);

  expect(() =>
    mod.parseServerEnv(withoutKey(validServerEnv(), "SURREAL_URL"))
  ).toThrow();
});

test("a reintroduced legacy DATABASE_URL is rejected by the strict contract", async () => {
  const mod: ServerEnvModule = await import(SERVER_ENV_MODULE);

  expect(() =>
    mod.parseServerEnv({
      ...validServerEnv(),
      DATABASE_URL: "postgres://localhost:5432/legacy",
    })
  ).toThrow();
});
