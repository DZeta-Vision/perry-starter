import { expect, test } from "vitest";

// Conformance gate — the server env contract.
//
// The server env pins PERRY_TARGET to a closed enum (local-sidecar |
// cloud-relay), keeps the SURREAL_* connection contract required, and carries
// NO legacy DATABASE_URL key. The pure parse seam (parseServerEnv /
// serverEnvSchema) is imported dynamically inside each test body so the env
// module's eager validation runs only at test time, never at file collection.
//
// The mutation twin (perry-target.mutation.test.ts) feeds known-bad env and
// proves this contract genuinely rejects it.

const SECRET_MIN_LENGTH = 32;
const SERVER_ENV_MODULE = "@perry-starter/env/server";

interface ServerEnvModule {
  parseServerEnv: (input: Record<string, unknown>) => unknown;
  serverEnvSchema: { shape: Record<string, unknown> };
}

const REQUIRED_SURREAL_KEYS = [
  "SURREAL_URL",
  "SURREAL_NS",
  "SURREAL_DB",
  "SURREAL_USER",
  "SURREAL_PASS",
];

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

test("the server env contract accepts both PERRY_TARGET values with the full SURREAL contract present", async () => {
  const mod: ServerEnvModule = await import(SERVER_ENV_MODULE);

  // A fully valid env parses for BOTH legal targets — proving the enum
  // membership is exactly {local-sidecar, cloud-relay}.
  expect(() => mod.parseServerEnv(validServerEnv())).not.toThrow();
  expect(() =>
    mod.parseServerEnv({ ...validServerEnv(), PERRY_TARGET: "cloud-relay" })
  ).not.toThrow();
});

test("the env schema owns PERRY_TARGET and every SURREAL_* key and carries no DATABASE_URL", async () => {
  const mod: ServerEnvModule = await import(SERVER_ENV_MODULE);
  const shapeKeys = Object.keys(mod.serverEnvSchema.shape);

  expect(shapeKeys).toContain("PERRY_TARGET");
  for (const key of REQUIRED_SURREAL_KEYS) {
    expect(shapeKeys).toContain(key);
  }
  // The legacy DATABASE_URL is provably absent — this reddens the moment a
  // dangling DATABASE_URL is reintroduced into the schema.
  expect(shapeKeys).not.toContain("DATABASE_URL");
});
